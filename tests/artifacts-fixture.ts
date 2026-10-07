import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LocalArtifactStore } from "../packages/artifacts/local-store";
import type { ArtifactStore } from "../packages/artifacts/store";
import { createApp } from "../services/control/app";
import { hashToken } from "../services/control/auth";
import { createDatabase } from "../services/control/db";

const url =
  process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev";
export function artifactFixture() {
  const sql = createDatabase(url);
  const directory = mkdtempSync(join(tmpdir(), "assistant-artifacts-"));
  const storage = new LocalArtifactStore(directory);
  beforeAll(async () => {
    const migration = Bun.spawn(["bun", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: url },
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await migration.exited) !== 0) throw new Error("Migration failed");
  });
  afterAll(async () => {
    await sql.end();
    await rm(directory, { recursive: true, force: true });
  });
  async function fixture(store: ArtifactStore = storage) {
    const workspace = crypto.randomUUID(),
      conversation = crypto.randomUUID(),
      vm = crypto.randomUUID(),
      token = crypto.randomUUID() + crypto.randomUUID(),
      vmToken = crypto.randomUUID() + crypto.randomUUID();
    await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'artifact-test')`;
    await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'artifact-test')`;
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'artifact-test')`;
    await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'client',NULL),(${await hashToken(vmToken)},${workspace},'vm',${vm})`;
    return {
      workspace,
      conversation,
      vm,
      token,
      vmToken,
      app: createApp(sql, { artifactStore: store }),
    };
  }
  return { sql, storage, directory, fixture };
}
export type Fixture = Awaited<ReturnType<ReturnType<typeof artifactFixture>["fixture"]>>;
export function send(context: Fixture, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${context.token}`);
  return context.app.request(path, { ...init, headers });
}
export function json(context: Fixture, path: string, value: unknown) {
  return send(context, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
export function upload(
  context: Fixture,
  data: { readonly id: string; readonly bytes: Uint8Array; readonly name?: string },
) {
  return send(context, `/v1/conversations/${context.conversation}/artifacts`, {
    method: "POST",
    headers: {
      "X-Artifact-Id": data.id,
      "X-Artifact-Name": encodeURIComponent(data.name ?? "bytes.bin"),
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([new Uint8Array(data.bytes)]),
  });
}
export const errorCode = z.object({ error: z.object({ code: z.string() }) });
