import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { LocalArtifactStore } from "../packages/artifacts/local-store";
import { createApp } from "../services/control/app";
import { createDatabase, type Database } from "../services/control/db";
import { postgresTool } from "./postgres-tools";
import {
  createRestoreFixture,
  digest,
  verifyCorruptBlob,
  verifyMissingBlob,
  verifyRestoredFixture,
} from "./qa-artifact-restore-fixture";

if (process.argv.includes("--help")) {
  console.log(
    "bun scripts/qa-artifact-restore.ts [EVIDENCE_DIRECTORY]\nUses only new UUID databases on 127.0.0.1:55439 and temporary local objects. Optional QA_POSTGRES_USER/QA_POSTGRES_PASSWORD configure local authentication. No models, network listeners, remote storage or existing databases are used.",
  );
  process.exit(0);
}

const runId = crypto.randomUUID();
const evidence = resolve(process.argv[2] ?? ".omo/evidence/artifact-restore-rehearsal", runId);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), "artifact-restore-"));
const sourceRoot = join(temporary, "source-objects");
const destinationRoot = join(temporary, "restored-objects");
const archive = join(temporary, "assistant.dump");
const adminUrl = new URL("postgres://127.0.0.1:55439/postgres");
adminUrl.username = process.env["QA_POSTGRES_USER"] ?? userInfo().username;
adminUrl.password = process.env["QA_POSTGRES_PASSWORD"] ?? "";
const databases: string[] = [];
const connections: Database[] = [];
const events: Readonly<Record<string, unknown>>[] = [];
function record(event: string, data: Readonly<Record<string, unknown>>) {
  const entry = { event, ...data };
  events.push(entry);
  console.log(JSON.stringify(entry));
}

async function script(name: string, url: URL, args: readonly string[] = []) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, name), ...args], {
    env: { PATH: process.env["PATH"], HOME: process.env["HOME"], DATABASE_URL: url.href },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await Bun.write(
    join(evidence, `${name}.log`),
    JSON.stringify(
      {
        invocation: `bun scripts/${name}${args.length ? " <synthetic-archive>" : ""}`,
        exitCode,
        stdout,
        stderr,
      },
      null,
      2,
    ),
  );
  assert.equal(exitCode, 0, `${name} failed; see bounded local evidence`);
  return stdout;
}

async function counts(sql: Database) {
  const tables = z
    .array(z.object({ tablename: z.string() }))
    .parse(
      await sql`SELECT tablename FROM pg_tables WHERE schemaname='assistant' ORDER BY tablename`,
    );
  const result: Record<string, number> = {};
  for (const table of tables) {
    result[table.tablename] = z
      .object({ count: z.coerce.number() })
      .parse(
        (await sql`SELECT count(*) AS count FROM ${sql(`assistant.${table.tablename}`)}`)[0],
      ).count;
  }
  return result;
}

try {
  // Given only UUID-named databases and synthetic principals; no fixture defaults are imported.
  const urls: URL[] = [];
  for (const role of ["source", "destination"]) {
    const name = `qa_ar_${role}_${runId.replaceAll("-", "")}`;
    await postgresTool(["createdb", "--template=template0", name], adminUrl);
    databases.push(name);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    urls.push(url);
  }
  const [sourceUrl, destinationUrl] = urls;
  assert.ok(sourceUrl && destinationUrl);
  record("databases.created", { host: "127.0.0.1", port: 55439, databases });
  await script("migrate.ts", sourceUrl);
  const source = createDatabase(sourceUrl.href);
  connections.push(source);
  const migrationFiles = (await readdir(join(import.meta.dir, "../infra/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const expectedMigrations = await Promise.all(
    migrationFiles.map(async (name) => ({
      name,
      checksum: digest(await Bun.file(join(import.meta.dir, "../infra/migrations", name)).text()),
    })),
  );
  const migrations = z
    .array(z.object({ name: z.string(), checksum: z.string() }))
    .parse(await source`SELECT name,checksum FROM assistant.schema_migrations ORDER BY name`);
  assert.deepEqual(migrations, expectedMigrations);
  await Bun.write(join(evidence, "migrations.json"), JSON.stringify(migrations, null, 2));
  record("schema.current", {
    count: migrations.length,
    manifest_sha256: digest(JSON.stringify(migrations)),
  });
  const sourceStore = new LocalArtifactStore(sourceRoot);
  const sourceApp = createApp(source, { artifactStore: sourceStore });
  const fixture = await createRestoreFixture(source, sourceApp);
  await Bun.write(join(evidence, "expected.bin"), fixture.bytes);
  record("fixture.created", fixture.identity);
  const sourceCounts = await counts(source);

  // When the database archive and separately copied object directory are restored independently.
  await script("backup.ts", sourceUrl, [archive]);
  const archiveSha256 = digest(new Uint8Array(await Bun.file(archive).arrayBuffer()));
  await script("restore-check.ts", sourceUrl, [archive]);
  await postgresTool(
    [
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      `--dbname=${destinationUrl.pathname.slice(1)}`,
      archive,
    ],
    destinationUrl,
  );
  await cp(sourceRoot, destinationRoot, { recursive: true, errorOnExist: true, force: false });
  await rename(sourceRoot, `${sourceRoot}.offline`);
  assert.equal(await sourceStore.get(fixture.identity.object_key), null);
  const destination = createDatabase(destinationUrl.href);
  connections.push(destination);
  const restoredCounts = await counts(destination);
  assert.deepEqual(restoredCounts, sourceCounts);
  const restoredMigrations = z
    .array(z.object({ name: z.string(), checksum: z.string() }))
    .parse(await destination`SELECT name,checksum FROM assistant.schema_migrations ORDER BY name`);
  assert.deepEqual(restoredMigrations, expectedMigrations);
  const restoredApp = createApp(destination, {
    artifactStore: new LocalArtifactStore(destinationRoot),
  });
  const positive = await verifyRestoredFixture(restoredApp, fixture, evidence);
  record("restore.positive", {
    archive_sha256: archiveSha256,
    source_objects_unavailable: true,
    table_count: Object.keys(restoredCounts).length,
    ...positive,
  });
  const corrupted = await verifyCorruptBlob(restoredApp, fixture, destinationRoot);
  await Bun.write(join(evidence, "corrupted-download.bin"), corrupted.downloaded);
  record("restore.corrupt_blob", corrupted.observation);

  // Then database counts still pass with a missing restored blob, but the actual download fails.
  const objectPath = join(destinationRoot, fixture.identity.object_key);
  await rename(objectPath, `${objectPath}.offline`);
  const missingBlobCounts = await counts(destination);
  assert.deepEqual(missingBlobCounts, sourceCounts);
  record("restore.negative", await verifyMissingBlob(restoredApp, fixture));
  await Bun.write(
    join(evidence, "row-counts.json"),
    JSON.stringify(
      { source: sourceCounts, restored: restoredCounts, missing_blob: missingBlobCounts },
      null,
      2,
    ),
  );
  record("rehearsal.passed", {
    scope: "Local PostgreSQL + LocalArtifactStore only",
    excludes: [
      "R2 backup",
      "VM journal disaster recovery",
      "remote infrastructure",
      "UI",
      "model execution",
    ],
  });
} catch (error) {
  if (!(error instanceof Error)) throw error;
  record("rehearsal.failed", {
    type: error.name,
    code: "code" in error ? error.code : null,
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 4000) : null,
  });
  process.exitCode = 1;
} finally {
  const connectionCleanup = await Promise.allSettled(
    connections.map((connection) => connection.end()),
  );
  const databaseCleanup = await Promise.allSettled(
    databases.map((name) => postgresTool(["dropdb", "--force", name], adminUrl)),
  );
  const fileCleanup = await Promise.allSettled([rm(temporary, { recursive: true, force: true })]);
  const failures = {
    connections: connectionCleanup.filter((result) => result.status === "rejected").length,
    databases: databaseCleanup.filter((result) => result.status === "rejected").length,
    files: fileCleanup.filter((result) => result.status === "rejected").length,
  };
  if (Object.values(failures).some((count) => count > 0)) process.exitCode = 1;
  record("cleanup.finished", {
    databases,
    temporary_files_removed: failures.files === 0,
    failures,
    listeners_created: 0,
  });
  await Bun.write(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        run_id: runId,
        invocation: "bun scripts/qa-artifact-restore.ts",
        exit_code: process.exitCode ?? 0,
        events,
      },
      null,
      2,
    ),
  );
  console.log(`EVIDENCE_RECORDED: ${evidence}`);
}
