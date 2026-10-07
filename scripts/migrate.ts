import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createDatabase } from "../services/control/db";

class MigrationError extends Error {
  constructor(readonly migration: string) { super(`Applied migration changed: ${migration}`); }
}

if (process.argv.includes("--help")) {
  console.log("DATABASE_URL=postgres://... bun scripts/migrate.ts\nApplies checked migrations to the isolated assistant schema.");
  process.exit(0);
}
const url = z.string().url().parse(process.env["DATABASE_URL"]);
const sql = createDatabase(url);
try {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(619083002)`;
    await tx`CREATE SCHEMA IF NOT EXISTS assistant`;
    await tx`SET LOCAL search_path TO assistant,public`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const path = join(import.meta.dir, "../infra/migrations");
    for (const name of (await readdir(path)).filter(name => name.endsWith(".sql")).sort()) {
      const source = await Bun.file(join(path, name)).text();
      const checksum = new Bun.CryptoHasher("sha256").update(source).digest("hex");
      const [prior] = await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
      if (prior) {
        if (prior["checksum"] !== checksum) throw new MigrationError(name);
        continue;
      }
      await tx.unsafe(source);
      await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${checksum})`;
      console.log(`Applied ${name}`);
    }
  });
} finally {
  await sql.end();
}
