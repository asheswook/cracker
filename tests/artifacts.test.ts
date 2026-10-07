import { expect, test } from "bun:test";
import { z } from "zod";
import { Artifact, DaemonPoll, Message } from "../packages/protocol";
import { artifactFixture, errorCode, json, send, upload } from "./artifacts-fixture";
import { MAX_ARTIFACT_BYTES, WORKSPACE_ARTIFACT_BYTES } from "../packages/artifacts/limits";

const { fixture, sql } = artifactFixture();

const envelope = z.object({ artifact: Artifact });

test("uploads actual binary bytes and serves an authenticated inert download", async () => {
  // Given binary bytes including NUL and non-UTF8 values.
  const context = await fixture(),
    bytes = new Uint8Array([0, 255, 128, 1, 42]),
    id = crypto.randomUUID();
  // When uploading and downloading through the actual API/filesystem adapter.
  const response = await upload(context, { id, bytes, name: "자료.bin" });
  expect(response.status).toBe(201);
  const artifact = envelope.parse(await response.json()).artifact;
  const downloaded = await send(context, `/v1/artifacts/${id}/content`);
  // Then bytes, computed digest, private download headers and metadata agree.
  expect(artifact.bytes).toBe(bytes.length);
  expect(artifact.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(downloaded.headers.get("Content-Disposition")).toStartWith("attachment;");
  expect(downloaded.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(downloaded.headers.get("Cache-Control")).toBe("private, no-store");
});

test("binds file-only messages idempotently and rejects different attachment identity", async () => {
  // Given an uploaded file in this conversation.
  const context = await fixture(),
    id = crypto.randomUUID();
  await upload(context, { id, bytes: new TextEncoder().encode("file data") });
  const body = { client_message_id: crypto.randomUUID(), content: "", attachment_ids: [id] };
  // When sending an attachment-only message twice.
  const first = z
    .object({ message: Message })
    .parse(
      await (
        await json(context, `/v1/conversations/${context.conversation}/messages`, body)
      ).json(),
    );
  const repeated = z
    .object({ message: Message })
    .parse(
      await (
        await json(context, `/v1/conversations/${context.conversation}/messages`, body)
      ).json(),
    );
  // Then same message and file metadata survive retrieval; changed binding conflicts.
  expect(first.message.id).toBe(repeated.message.id);
  expect(first.message.attachments?.[0]?.id).toBe(id);
  const listed = z
    .object({ messages: z.array(Message) })
    .parse(
      await (await send(context, `/v1/conversations/${context.conversation}/messages`)).json(),
    );
  expect(listed.messages[0]?.attachments?.[0]?.id).toBe(id);
  const changed = await json(context, `/v1/conversations/${context.conversation}/messages`, {
    ...body,
    content: "changed",
    attachment_ids: [],
  });
  expect(changed.status).toBe(409);
});

test("enforces workspace/conversation scope and deletion leaves a tombstone", async () => {
  // Given an uploaded and linked artifact.
  const context = await fixture(),
    alien = await fixture(),
    id = crypto.randomUUID();
  await upload(context, { id, bytes: new Uint8Array([7]) });
  await json(context, `/v1/conversations/${context.conversation}/messages`, {
    client_message_id: crypto.randomUUID(),
    content: "file",
    attachment_ids: [id],
  });
  // When another workspace downloads/binds or owner deletes.
  expect((await send(alien, `/v1/artifacts/${id}/content`)).status).toBe(404);
  expect(
    (
      await json(alien, `/v1/conversations/${alien.conversation}/messages`, {
        client_message_id: crypto.randomUUID(),
        content: "bad",
        attachment_ids: [id],
      })
    ).status,
  ).toBe(409);
  const otherConversation = crypto.randomUUID();
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${otherConversation},${context.workspace},'separate')`;
  expect(
    (
      await json(context, `/v1/conversations/${otherConversation}/messages`, {
        client_message_id: crypto.randomUUID(),
        content: "bad conversation",
        attachment_ids: [id],
      })
    ).status,
  ).toBe(409);
  expect((await send(context, `/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200);
  // Then future downloads fail and historical message retains deleted metadata.
  expect((await send(context, `/v1/artifacts/${id}/content`)).status).toBe(404);
  const listed = z
    .object({ messages: z.array(Message) })
    .parse(
      await (await send(context, `/v1/conversations/${context.conversation}/messages`)).json(),
    );
  expect(listed.messages[0]?.attachments?.[0]?.state).toBe("deleted");
  const retried = await upload(context, { id, bytes: new Uint8Array([7]) });
  expect(errorCode.parse(await retried.json()).error.code).toBe("artifact_deleted");
});

test("permits run-bound daemon publication and denies another conversation", async () => {
  // Given an actual claimed task run.
  const context = await fixture();
  await json(context, `/v1/conversations/${context.conversation}/messages`, {
    client_message_id: crypto.randomUUID(),
    content: "create file",
  });
  const assignment = DaemonPoll.parse(
    await (
      await send(context, "/v1/daemon/poll", {
        headers: { Authorization: `Bearer ${context.vmToken}` },
      })
    ).json(),
  ).assignment;
  if (!assignment) throw new Error("Missing run");
  const id = crypto.randomUUID(),
    body = new Blob(["generated output"]);
  // When daemon publishes and attaches a result, then attempts an unrelated conversation.
  const result = await send(
    context,
    `/v1/daemon/conversations/${context.conversation}/artifacts?run_id=${assignment.run_id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.vmToken}`,
        "X-Artifact-Id": id,
        "X-Artifact-Name": "result.txt",
        "Content-Type": "text/plain",
      },
      body,
    },
  );
  expect(result.status).toBe(201);
  const posted = await send(context, "/v1/daemon/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${context.vmToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "message",
      event_id: crypto.randomUUID(),
      run_id: assignment.run_id,
      content: "",
      attachment_ids: [id],
    }),
  });
  expect(posted.status).toBe(200);
  const alien = await fixture();
  const denied = await send(
    context,
    `/v1/daemon/conversations/${alien.conversation}/artifacts?run_id=${assignment.run_id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.vmToken}`,
        "X-Artifact-Id": crypto.randomUUID(),
        "X-Artifact-Name": "bad.txt",
      },
      body,
    },
  );
  expect(denied.status).toBe(404);
  // Then run-authorized retrieval returns the exact generated output.
  const download = await send(
    context,
    `/v1/daemon/artifacts/${id}/content?run_id=${assignment.run_id}`,
    { headers: { Authorization: `Bearer ${context.vmToken}` } },
  );
  expect(await download.text()).toBe("generated output");
});

test("caps actual stream bytes and database quota, releasing quota only after deletion", async () => {
  // Given a near-quota workspace and actual legacy 10MiB files.
  const context = await fixture(),
    bytes = new Uint8Array(10 * 1024 * 1024),
    ids: string[] = [];
  for (let remaining = WORKSPACE_ARTIFACT_BYTES - 10 * bytes.length; remaining > 0;) {
    const reserved = crypto.randomUUID(), size = Math.min(remaining, MAX_ARTIFACT_BYTES);
    await sql`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,lease_id,state)
      VALUES(${reserved},${context.workspace},${context.conversation},'prior.bin','application/octet-stream',${size},${'0'.repeat(64)},${context.workspace + '/' + reserved},${crypto.randomUUID()},'ready')`;
    remaining -= size;
  }
  for (let index = 0; index < 10; index++) {
    const id = crypto.randomUUID();
    ids.push(id);
    expect((await upload(context, { id, bytes })).status).toBe(201);
  }
  // When exceeding workspace quota or per-upload actual bytes.
  const quota = await upload(context, { id: crypto.randomUUID(), bytes: new Uint8Array([1]) });
  expect(errorCode.parse(await quota.json()).error.code).toBe("artifact_quota_exceeded");
  expect(
    (await upload(context, { id: crypto.randomUUID(), bytes: new Uint8Array(bytes.length + 1) }))
      .status,
  ).toBe(413);
  // Then completed deletion frees reservation for a new upload.
  const first = ids[0];
  if (!first) throw new Error("Missing file");
  await send(context, `/v1/artifacts/${first}`, { method: "DELETE" });
  expect(
    (await upload(context, { id: crypto.randomUUID(), bytes: new Uint8Array([1]) })).status,
  ).toBe(201);
  const count = z
    .object({ bytes: z.coerce.number() })
    .parse(
      (
        await sql`SELECT sum(bytes) AS bytes FROM assistant.artifacts WHERE workspace_id=${context.workspace} AND purged_at IS NULL`
      )[0],
    );
  expect(count.bytes).toBe(WORKSPACE_ARTIFACT_BYTES - bytes.length + 1);
}, 30000);
