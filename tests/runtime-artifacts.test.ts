import { beforeAll, afterAll, test, expect, spyOn } from "bun:test";
import fsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { LocalArtifactStore } from "../packages/artifacts/local-store.ts";
import { Artifact, Message } from "../packages/protocol/index.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";
import { MAX_ARTIFACT_BYTES } from "../packages/artifacts/limits.ts";
const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), conversation = crypto.randomUUID(), task = crypto.randomUUID(), run = crypto.randomUUID(), clientToken = crypto.randomUUID() + crypto.randomUUID(), vmToken = crypto.randomUUID() + crypto.randomUUID();
const dir = await mkdtemp(join(tmpdir(), "runtime-artifact-test-"));
const app = createApp(sql, { artifactStore: new LocalArtifactStore(join(dir, "store")) });
const server = Bun.serve({ port: 0, fetch: app.fetch });
const http = ky.create({ prefixUrl: server.url.href, headers: { Authorization: `Bearer ${vmToken}` }, retry: 0 });
beforeAll(async () => {
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'runtime-artifacts')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(clientToken)},${workspace},'client',NULL),(${await hashToken(vmToken)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'artifacts')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'artifact test','running')`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
});
afterAll(async () => { await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`; await server.stop(true); await sql.end(); await rm(dir, { recursive: true }); });
async function upload(content: string) {
  const response = await app.request(`/v1/conversations/${conversation}/artifacts`, { method: "POST", headers: { Authorization: `Bearer ${clientToken}`, "X-Artifact-Id": crypto.randomUUID(), "X-Artifact-Name": "source.txt", "Content-Type": "text/plain" }, body: content });
  if (response.status !== 201) throw new TypeError(`Upload failed ${response.status}`);
  return z.object({ artifact: Artifact }).parse(await response.json()).artifact;
}
function message(artifact: z.infer<typeof Artifact>) { return Message.parse({ id: crypto.randomUUID(), conversation_id: conversation, role: "user", content: "Read my attachment", sequence: 1, created_at: new Date().toISOString(), client_message_id: null, attachments: [artifact] }); }
async function files() { return TaskArtifacts.create({ http, runId: run, conversationId: conversation, root: join(dir, "runs") }); }
test("authorized document bytes become a Responses file input", async () => {
  // Given a real uploaded file in PostgreSQL and local object storage.
  const artifact = await upload("ATTACHMENT_PROOF_731"), artifacts = await files();
  // When
  const inputs = await artifacts.input(message(artifact), AbortSignal.timeout(5000));
  // Then
  let fileData: string | undefined;
  for (const item of inputs) if ("content" in item && Array.isArray(item.content)) for (const part of item.content) if (part.type === "input_file") fileData = part.file_data ?? undefined;
  expect(fileData).toBe(`data:text/plain;base64,${Buffer.from("ATTACHMENT_PROOF_731").toString("base64")}`);
});
test("download rejects a mismatching evidence hash", async () => {
  // Given
  const artifact = await upload("untampered source"), artifacts = await files();
  // When / Then
  await expect(artifacts.input(message({ ...artifact, sha256: "0".repeat(64) }), AbortSignal.timeout(5000))).rejects.toThrow("attachment_integrity_failed");
});
test("fresh task output publishes and attaches actual stored bytes", async () => {
  // Given
  const artifacts = await files(); await writeFile(join(artifacts.outputDirectory, "result.txt"), "GENERATED_PROOF_42");
  // When
  const artifact = await artifacts.publish(JSON.stringify({ path: "result.txt", name: "result.txt", media_type: "text/plain" }), AbortSignal.timeout(5000));
  const event = await app.request("/v1/daemon/events", { method: "POST", headers: { Authorization: `Bearer ${vmToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "message", event_id: crypto.randomUUID(), run_id: run, content: "", attachment_ids: [artifact.id] }) });
  const downloaded = await app.request(`/v1/artifacts/${artifact.id}/content`, { headers: { Authorization: `Bearer ${clientToken}` } });
  // Then
  expect(event.status).toBe(200); expect(await downloaded.text()).toBe("GENERATED_PROOF_42");
});
test("100 MB task output publishes and downloads locally without model inline expansion", async () => {
  const artifacts = await files();
  const path = join(artifacts.outputDirectory, "large.bin");
  await Bun.write(path, new Uint8Array(MAX_ARTIFACT_BYTES));
  const artifact = await artifacts.publish(JSON.stringify({ path: "large.bin", name: "large.bin", media_type: "application/octet-stream" }), AbortSignal.timeout(30000));
  expect(artifact.bytes).toBe(MAX_ARTIFACT_BYTES);
  const inputs = await artifacts.input(message(artifact), AbortSignal.timeout(30000));
  const texts: string[] = [];
  for (const item of inputs) if ("content" in item && Array.isArray(item.content)) for (const part of item.content) {
    expect(part.type).toBe("input_text");
    if (part.type === "input_text") texts.push(part.text);
  }
  const metadata = z.object({ local_path: z.string(), id: z.string() }).parse(JSON.parse(texts[0] ?? '{}'));
  expect(metadata.id).toBe(artifact.id);
  const downloaded = Bun.file(metadata.local_path);
  expect(downloaded.size).toBe(MAX_ARTIFACT_BYTES);
  expect(new Bun.CryptoHasher("sha256").update(await downloaded.arrayBuffer()).digest("hex")).toBe(artifact.sha256);
}, 60000);
test("publication rejects existing files outside the task output directory", async () => {
  // Given
  const artifacts = await files(), outside = join(dir, "existing.txt"); await writeFile(outside, "private fixture");
  // When / Then
  await expect(artifacts.publish(JSON.stringify({ path: outside, name: "result.txt", media_type: "text/plain" }), AbortSignal.timeout(5000))).rejects.toThrow("publish_requires_task_output");
});
test("publication rejects a file grown between lstat and open instead of publishing a truncated prefix", async () => {
  const artifacts = await files(), path = join(artifacts.outputDirectory, 'growing.txt');
  await writeFile(path, 'original');
  const canonical = await fsPromises.realpath(path);
  const filesystem = { ...fsPromises };
  let changed = false;
  const racedOpen: typeof fsPromises.open = async (selected, flags, mode) => {
    if (selected === canonical) { await filesystem.appendFile(path, '-new-content'); changed = true; }
    return filesystem.open(selected, flags, mode);
  };
  const race = spyOn(fsPromises, 'open').mockImplementation(racedOpen);
  try {
    await expect(artifacts.publish(JSON.stringify({ path: 'growing.txt', name: 'growing.txt', media_type: 'text/plain' }), AbortSignal.timeout(5000)))
      .rejects.toThrow('artifact_changed_during_open');
    expect(changed).toBe(true);
    expect(await sql`SELECT id FROM assistant.artifacts WHERE workspace_id=${workspace} AND name='growing.txt'`).toHaveLength(0);
  } finally { race.mockRestore(); }
});
test("publication rejects symlinks even inside the task output directory", async () => {
  // Given
  const artifacts = await files(), outside = join(dir, "symlink-source.txt"); await writeFile(outside, "fixture"); await symlink(outside, join(artifacts.outputDirectory, "link.txt"));
  // When / Then
  await expect(artifacts.publish(JSON.stringify({ path: "link.txt", name: "result.txt", media_type: "text/plain" }), AbortSignal.timeout(5000))).rejects.toThrow("publish_requires_regular_task_file");
});
test("publication rejects hardlinks to existing files", async () => {
  // Given
  const artifacts = await files(), outside = join(dir, "hardlink-source.txt"); await writeFile(outside, "fixture"); await link(outside, join(artifacts.outputDirectory, "link.txt"));
  // When / Then
  await expect(artifacts.publish(JSON.stringify({ path: "link.txt", name: "result.txt", media_type: "text/plain" }), AbortSignal.timeout(5000))).rejects.toThrow("publish_requires_regular_task_file");
});

test("historical deleted attachment becomes unavailable metadata without failing the turn", async () => {
  // Given a real uploaded artifact that has since been deleted.
  const artifact = await upload("historical source"), artifacts = await files();
  await app.request(`/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${clientToken}` } });
  // When
  const inputs = await artifacts.input(message({ ...artifact, state: "deleted" }), AbortSignal.timeout(5000));
  // Then the model receives a machine-readable tombstone, not invented file content.
  const unavailable = inputs.flatMap(item => "role" in item && item.role === "user" && "content" in item && typeof item.content === "string" && item.content.startsWith("{") ? [JSON.parse(item.content)] : []);
  expect(unavailable.some(item => item.kind === "unavailable_attachment" && item.id === artifact.id && item.state === "deleted")).toBe(true);
});
test("historical download deletion race continues with unavailable metadata", async () => {
  // Given ready metadata read before its historical artifact was deleted.
  const artifact = await upload("old source");
  await app.request(`/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${clientToken}` } });
  const artifacts = await TaskArtifacts.create({ http, runId: run, conversationId: conversation, root: join(dir, "runs"), taskCreatedAt: "2026-01-01T00:00:00Z" });
  // When
  const inputs = await artifacts.input({ ...message(artifact), created_at: "2025-01-01T00:00:00Z" }, AbortSignal.timeout(5000));
  // Then
  expect(inputs.some(item => "content" in item && typeof item.content === "string" && item.content.includes('"kind":"unavailable_attachment"'))).toBe(true);
});
test("active attachment download failure is explicit rather than fabricated content", async () => {
  // Given a required current attachment disappears before its bytes arrive.
  const artifact = await upload("current source"), artifacts = await files();
  await app.request(`/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${clientToken}` } });
  // When / Then
  await expect(artifacts.input(message(artifact), AbortSignal.timeout(5000))).rejects.toThrow("attachment_http_404");
});
