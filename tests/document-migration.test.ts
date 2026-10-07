import { expect, test } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";

test("migration only resets ready supported null bodies and seeds no jobs", async () => {
  const sql = createDatabase(
    process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
  );
  const schema = `document_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await sql`CREATE SCHEMA ${sql(schema)}`;
    const result = await sql.begin(async (tx) => {
      await tx`SELECT set_config('search_path',${schema},true)`;
      for (const name of ["001_control.sql", "007_artifacts.sql", "013_artifact_search.sql"])
        await tx.unsafe(await Bun.file(`infra/migrations/${name}`).text());
      const workspace = crypto.randomUUID(),
        conversation = crypto.randomUUID();
      await tx`INSERT INTO workspaces(id,name) VALUES(${workspace},'migration-synthetic')`;
      await tx`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'migration-synthetic')`;
      const cases = [
        { name: "ready.pdf", mime: "application/pdf", state: "ready", text: null },
        { name: "ready.docx", mime: "application/octet-stream", state: "ready", text: null },
        { name: "body.pdf", mime: "application/pdf", state: "ready", text: "existing" },
        { name: "deleted.pdf", mime: "application/pdf", state: "deleted", text: null },
        { name: "plain.txt", mime: "text/plain", state: "ready", text: null },
        { name: "image.png", mime: "image/png", state: "ready", text: null },
      ];
      for (const value of cases) {
        const id = crypto.randomUUID();
        await tx`INSERT INTO artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id,search_text,search_indexed)
          VALUES(${id},${workspace},${conversation},${value.name},${value.mime},1,${"0".repeat(64)},${id},${value.state},${crypto.randomUUID()},${value.text},true)`;
      }
      await tx.unsafe(await Bun.file("infra/migrations/024_artifact_document_index.sql").text());
      const rows = z
        .array(
          z.object({
            name: z.string(),
            search_indexed: z.boolean(),
            search_text: z.string().nullable(),
          }),
        )
        .parse(await tx`SELECT name,search_indexed,search_text FROM artifacts ORDER BY name`);
      const jobs = z
        .object({ count: z.coerce.number() })
        .parse((await tx`SELECT count(*) FROM artifact_search_jobs`)[0]).count;
      return { rows, jobs };
    });
    expect(result.rows.filter((row) => !row.search_indexed).map((row) => row.name)).toEqual([
      "ready.docx",
      "ready.pdf",
    ]);
    expect(result.rows.find((row) => row.name === "body.pdf")?.search_text).toBe("existing");
    expect(result.jobs).toBe(0);
    await Bun.write(
      ".omo/evidence/attachment-body-index/migration-result.json",
      JSON.stringify(result, null, 2),
    );
  } finally {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.end();
  }
});
