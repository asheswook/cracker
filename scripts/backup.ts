import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { databaseUrl, postgresTool } from "./postgres-tools";

if (process.argv.includes("--help")) {
  console.log(
    "DATABASE_URL=... bun scripts/backup.ts ARCHIVE\nCreates a new private PostgreSQL custom archive of the assistant schema. Never overwrites an archive.",
  );
  process.exit(0);
}

try {
  const path = resolve(z.string().min(1).parse(process.argv[2]));
  const url = databaseUrl();
  process.umask(0o077);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  await file.close();
  try {
    await postgresTool(
      [
        "pg_dump",
        "--format=custom",
        "--schema=assistant",
        "--no-owner",
        "--no-acl",
        `--file=${path}`,
      ],
      url,
    );
  } catch (error) {
    await unlink(path);
    throw error;
  }
  console.log(JSON.stringify({ event: "backup.created", path, schema: "assistant" }));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(JSON.stringify({ event: "backup.failed", type: error.name }));
  process.exitCode = 1;
}
