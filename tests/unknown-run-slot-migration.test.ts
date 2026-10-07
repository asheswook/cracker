import { expect, test } from "bun:test";
import { createDatabase } from "../services/control/db";

test("migration frees only unknown VM slots while preserving one known active and task uniqueness", async () => {
  const sql = createDatabase(
    process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
  );
  try {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE runs (id int, vm_id int, task_id int, state text)`;
      const original = await Bun.file("infra/migrations/001_control.sql").text();
      for (const name of ["run_vm_active", "run_task_active"]) {
        const statement = original
          .split("\n")
          .find((line) => line.startsWith(`CREATE UNIQUE INDEX ${name} `));
        if (!statement) throw new TypeError("Missing original unique index");
        await tx.unsafe(statement);
      }
      await tx`INSERT INTO runs VALUES (1,1,1,'unknown')`;
      let beforeRejected = false;
      try {
        await tx.savepoint(async (nested) => {
          await nested`INSERT INTO runs VALUES (2,1,2,'running')`;
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "23505")
          beforeRejected = true;
        else throw error;
      }
      expect(beforeRejected).toBe(true);
      await tx`SET LOCAL search_path TO pg_temp`;
      await tx.unsafe(await Bun.file("infra/migrations/044_unknown_run_slot.sql").text());
      await tx`INSERT INTO runs VALUES (2,1,2,'running')`;
      for (const values of [
        [3, 1, 3, "paused"],
        [4, 2, 1, "running"],
      ] as const) {
        let rejected = false;
        try {
          await tx.savepoint(async (nested) => {
            await nested`INSERT INTO runs VALUES (${values[0]},${values[1]},${values[2]},${values[3]})`;
          });
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "23505") rejected = true;
          else throw error;
        }
        expect(rejected).toBe(true);
      }
      expect(Array.from(await tx`SELECT id,state FROM runs ORDER BY id`)).toEqual([
        { id: 1, state: "unknown" },
        { id: 2, state: "running" },
      ]);
    });
  } finally {
    await sql.end();
  }
});
