import { join, resolve } from "node:path";
import { z } from "zod";
import { createDatabase } from "../services/control/db";
import { databaseUrl, postgresTool } from "./postgres-tools";

if (process.argv.includes("--help")) {
  console.log(
    "DATABASE_URL=... bun scripts/restore-check.ts ARCHIVE\nRestores into a uniquely named temporary database, reports restored row counts, then removes only that database. Requires CREATEDB. Never restores over the source database.",
  );
  process.exit(0);
}

try {
  const path = resolve(z.string().min(1).parse(process.argv[2]));
  if (!(await Bun.file(path).exists())) throw new TypeError("Archive not found");
  const url = databaseUrl();
  const name = `assistant_restore_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url.href);
  try {
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE template0`;
    try {
      const restoredUrl = new URL(url);
      restoredUrl.pathname = `/${name}`;
      await postgresTool(
        ["pg_restore", "--exit-on-error", "--no-owner", "--no-acl", `--dbname=${name}`, path],
        restoredUrl,
      );
      const restored = createDatabase(restoredUrl.href);
      try {
        const tables = z
          .array(z.object({ tablename: z.string() }))
          .parse(
            await restored`SELECT tablename FROM pg_tables WHERE schemaname='assistant' ORDER BY tablename`,
          );
        const names = new Set(tables.map((table) => table.tablename));
        if (
          ![
            "schema_migrations",
            "workspaces",
            "credentials",
            "conversations",
            "messages",
            "tasks",
            "runs",
          ].every((name) => names.has(name))
        ) {
          throw new TypeError("Archive does not contain the assistant core schema");
        }
        const migrations = z
          .array(
            z.object({ name: z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/), checksum: z.string() }),
          )
          .parse(
            await restored`SELECT name,checksum FROM assistant.schema_migrations ORDER BY name`,
          );
        if (!migrations.some((migration) => migration.name === "001_control.sql"))
          throw new TypeError("Archive migration history is missing");
        for (const migration of migrations) {
          const source = await Bun.file(
            join(import.meta.dir, "../infra/migrations", migration.name),
          ).text();
          const checksum = new Bun.CryptoHasher("sha256").update(source).digest("hex");
          if (checksum !== migration.checksum)
            throw new TypeError("Archive migration checksum differs from this release");
        }
        const counts: Record<string, number> = {};
        for (const table of tables) {
          const rows = z
            .array(z.object({ count: z.coerce.number() }))
            .parse(
              await restored`SELECT count(*) AS count FROM ${restored(`assistant.${table.tablename}`)}`,
            );
          const row = rows[0];
          if (!row) throw new TypeError("Missing restore count");
          counts[table.tablename] = row.count;
        }
        console.log(JSON.stringify({ event: "restore.verified", tables: counts }));
      } finally {
        await restored.end();
      }
    } finally {
      await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
    }
  } finally {
    await admin.end();
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(JSON.stringify({ event: "restore.failed", type: error.name }));
  process.exitCode = 1;
}
