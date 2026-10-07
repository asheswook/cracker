import assert from "node:assert/strict";
import { join } from "node:path";
import { z } from "zod";
import { Artifact, Conversation, Message } from "../packages/protocol";
import type { createApp } from "../services/control/app";
import { hashToken } from "../services/control/auth";
import type { Database } from "../services/control/db";

export const digest = (bytes: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
type App = ReturnType<typeof createApp>;
const MessageList = z.object({ messages: z.array(Message) });

export async function createRestoreFixture(sql: Database, app: App) {
  const workspace = crypto.randomUUID(),
    alienWorkspace = crypto.randomUUID();
  const token = crypto.randomUUID() + crypto.randomUUID(),
    alienToken = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'synthetic-restore-owner'),(${alienWorkspace},'synthetic-restore-alien')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role) VALUES(${await hashToken(token)},${workspace},'client'),(${await hashToken(alienToken)},${alienWorkspace},'client')`;
  const ownerHeaders = { Authorization: `Bearer ${token}` };
  const alienHeaders = { Authorization: `Bearer ${alienToken}` };
  const jsonHeaders = { ...ownerHeaders, "Content-Type": "application/json" };
  const created = await app.request("/v1/conversations", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ title: "synthetic restore rehearsal" }),
  });
  assert.equal(created.status, 201);
  const conversation = z.object({ conversation: Conversation }).parse(await created.json())
    .conversation.id;
  const artifactId = crypto.randomUUID(),
    clientMessageId = crypto.randomUUID();
  const bytes = new Uint8Array([0, 255, 128, 1, 42, 10, 13, 0]);
  const sha256 = digest(bytes);
  const upload = await app.request(`/v1/conversations/${conversation}/artifacts`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      "X-Artifact-Id": artifactId,
      "X-Artifact-Name": "restore.bin",
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([bytes]),
  });
  assert.equal(upload.status, 201);
  const artifact = z.object({ artifact: Artifact }).parse(await upload.json()).artifact;
  assert.equal(artifact.id, artifactId);
  assert.equal(artifact.sha256, sha256);
  const sent = await app.request(`/v1/conversations/${conversation}/messages`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      client_message_id: clientMessageId,
      content: "",
      attachment_ids: [artifactId],
    }),
  });
  assert.equal(sent.status, 200);
  const message = z.object({ message: Message }).parse(await sent.json()).message;
  assert.equal(message.attachments?.[0]?.id, artifactId);
  const listing = await app.request(`/v1/conversations/${conversation}/messages`, {
    headers: ownerHeaders,
  });
  assert.equal(listing.status, 200);
  const originalMessages = MessageList.parse(await listing.json()).messages;
  assert.equal(originalMessages[0]?.id, message.id);
  const objectKey = z
    .object({ object_key: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/) })
    .parse(
      (await sql`SELECT object_key FROM assistant.artifacts WHERE id=${artifactId}`)[0],
    ).object_key;
  const identity = {
    workspace,
    alienWorkspace,
    conversation,
    message_id: message.id,
    client_message_id: clientMessageId,
    artifact_id: artifactId,
    object_key: objectKey,
    bytes: bytes.length,
    sha256,
  };
  return { ownerHeaders, alienHeaders, bytes, originalMessages, identity } as const;
}
type Fixture = Awaited<ReturnType<typeof createRestoreFixture>>;

export async function verifyRestoredFixture(app: App, fixture: Fixture, evidence: string) {
  const { identity, bytes, ownerHeaders, alienHeaders } = fixture;
  const listing = await app.request(`/v1/conversations/${identity.conversation}/messages`, {
    headers: ownerHeaders,
  });
  assert.equal(listing.status, 200);
  const restoredMessages = MessageList.parse(await listing.json()).messages;
  assert.equal(restoredMessages.length, 1);
  assert.deepEqual(restoredMessages, fixture.originalMessages);
  const download = await app.request(`/v1/artifacts/${identity.artifact_id}/content`, {
    headers: ownerHeaders,
  });
  assert.equal(download.status, 200);
  const downloaded = new Uint8Array(await download.arrayBuffer());
  assert.deepEqual(downloaded, bytes);
  assert.equal(digest(downloaded), identity.sha256);
  await Bun.write(join(evidence, "downloaded.bin"), downloaded);
  const denied = await app.request(`/v1/artifacts/${identity.artifact_id}/content`, {
    headers: alienHeaders,
  });
  assert.equal(denied.status, 404);
  const denial = z
    .object({ error: z.object({ code: z.literal("not_found") }) })
    .parse(await denied.json());
  await Bun.write(
    join(evidence, "api-observations.json"),
    JSON.stringify(
      {
        originalMessages: fixture.originalMessages,
        restoredMessages,
        download_headers: {
          etag: download.headers.get("etag"),
          content_length: download.headers.get("content-length"),
        },
        unauthorized: denial,
      },
      null,
      2,
    ),
  );
  return {
    message_id: identity.message_id,
    artifact_id: identity.artifact_id,
    download_status: download.status,
    downloaded_sha256: digest(downloaded),
    unauthorized_status: denied.status,
    unauthorized_code: denial.error.code,
  };
}

export async function verifyCorruptBlob(app: App, fixture: Fixture, destinationRoot: string) {
  const corrupted = new Uint8Array(fixture.bytes);
  corrupted[0] = 1;
  const path = join(destinationRoot, fixture.identity.object_key);
  await Bun.write(path, corrupted);
  try {
    const response = await app.request(`/v1/artifacts/${fixture.identity.artifact_id}/content`, {
      headers: fixture.ownerHeaders,
    });
    assert.equal(response.status, 200);
    const downloaded = new Uint8Array(await response.arrayBuffer());
    assert.equal(downloaded.length, fixture.bytes.length);
    assert.notEqual(digest(downloaded), fixture.identity.sha256);
    return {
      downloaded,
      observation: {
        download_status: response.status,
        bytes: downloaded.length,
        expected_sha256: fixture.identity.sha256,
        actual_sha256: digest(downloaded),
        manifest_detected_corruption: true,
      },
    };
  } finally {
    await Bun.write(path, fixture.bytes);
  }
}

export async function verifyMissingBlob(app: App, fixture: Fixture) {
  const response = await app.request(`/v1/artifacts/${fixture.identity.artifact_id}/content`, {
    headers: fixture.ownerHeaders,
  });
  assert.equal(response.status, 503);
  const body = z
    .object({ error: z.object({ code: z.literal("artifact_storage_unavailable") }) })
    .parse(await response.json());
  return {
    row_counts_still_match: true,
    download_status: response.status,
    error_code: body.error.code,
  };
}
