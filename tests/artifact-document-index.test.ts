import { expect, test } from "bun:test";
import { z } from "zod";
import { DocumentLease } from "../packages/artifacts/document-types.ts";
import { WorkSearchPage } from "../packages/protocol/work-search.ts";
import { hashToken } from "../services/control/auth.ts";
import { artifactFixture, type Fixture, json, send, upload } from "./artifacts-fixture.ts";

const { fixture, sql } = artifactFixture();
const envelope = z.object({ job: DocumentLease.nullable() });
const search = {
  query: "BODYINDEXTOKEN",
  cursor: null,
  conversation_id: null,
  state: "all",
  limit: 10,
};
async function daemon(context: Fixture, path: string, body?: unknown) {
  return send(context, `/v1/daemon/artifact-index/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${context.vmToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function document(context: Fixture, linked = true) {
  const id = crypto.randomUUID(),
    bytes = new Uint8Array(await Bun.file("tests/fixtures/documents/ordinary.pdf").arrayBuffer());
  expect((await upload(context, { id, bytes, name: "paper.pdf" })).status).toBe(201);
  if (linked)
    await json(context, `/v1/conversations/${context.conversation}/messages`, {
      client_message_id: crypto.randomUUID(),
      content: "",
      attachment_ids: [id],
    });
  await sql`UPDATE assistant.tasks SET state='succeeded' WHERE workspace_id=${context.workspace}`;
  await sql`UPDATE assistant.vms SET last_seen_at=now() WHERE id=${context.vm}`;
  return { id, bytes };
}
async function claim(context: Fixture) {
  const response = await daemon(context, "claim");
  expect(response.status).toBe(200);
  const job = envelope.parse(await response.json()).job;
  if (!job) throw new Error("Expected document lease");
  return job;
}
function completion(job: z.infer<typeof DocumentLease>, text = "BODYINDEXTOKEN") {
  return {
    lease_id: job.lease_id,
    version: job.version,
    sha256: job.sha256,
    kind: "complete",
    text,
    truncated: false,
    code: "text",
  };
}

test("indexes linked binary bodies asynchronously without changing originals", async () => {
  const context = await fixture(),
    original = await document(context);
  const before = WorkSearchPage.parse(await (await json(context, "/v1/search", search)).json());
  expect(before.hits).toHaveLength(0);
  expect(before.pending_document_files).toBe(1);
  const job = await claim(context);
  const result = await daemon(context, `${job.artifact_id}/result`, completion(job));
  expect(result.status).toBe(200);
  const after = WorkSearchPage.parse(await (await json(context, "/v1/search", search)).json());
  expect(after.pending_document_files).toBe(0);
  expect(after.hits[0]?.id).toBe(original.id);
  expect(after.hits[0]?.snippet).toContain("BODYINDEXTOKEN");
  const download = await send(context, `/v1/artifacts/${original.id}/content`);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(original.bytes);
  await Bun.write(
    ".omo/evidence/attachment-body-index/http-search.json",
    JSON.stringify(
      {
        upload: 201,
        result: result.status,
        before,
        after,
        download_sha256: new Bun.CryptoHasher("sha256").update(original.bytes).digest("hex"),
      },
      null,
      2,
    ),
  );
});

test("claims at most one job per VM under concurrent requests and excludes unlinked uploads", async () => {
  const context = await fixture();
  await document(context, false);
  expect(envelope.parse(await (await daemon(context, "claim")).json()).job).toBeNull();
  await document(context);
  await document(context);
  const claims = await Promise.all(Array.from({ length: 4 }, () => daemon(context, "claim")));
  const jobs = await Promise.all(
    claims.map(async (response) => envelope.parse(await response.json()).job),
  );
  expect(jobs.filter(Boolean)).toHaveLength(1);
});

test("enforces workspace VM token hash and version ownership without changing body", async () => {
  const context = await fixture(),
    alien = await fixture();
  await document(context);
  const job = await claim(context);
  expect((await daemon(alien, `${job.artifact_id}/result`, completion(job))).status).toBe(409);
  expect(
    (
      await daemon(context, `${job.artifact_id}/result`, {
        ...completion(job),
        lease_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (await daemon(context, `${job.artifact_id}/result`, { ...completion(job), version: 2 })).status,
  ).toBe(400);
  expect(
    (
      await daemon(context, `${job.artifact_id}/result`, {
        ...completion(job),
        sha256: "0".repeat(64),
      })
    ).status,
  ).toBe(409);
  const denied = await send(alien, `/v1/daemon/artifact-index/${job.artifact_id}/content`, {
    headers: {
      Authorization: `Bearer ${alien.vmToken}`,
      "X-Document-Lease": job.lease_id,
      "X-Document-Version": "1",
    },
  });
  expect(denied.status).toBe(409);
  const downloaded = await send(context, `/v1/daemon/artifact-index/${job.artifact_id}/content`, {
    headers: {
      Authorization: `Bearer ${context.vmToken}`,
      "X-Document-Lease": job.lease_id,
      "X-Document-Version": "1",
    },
  });
  expect(downloaded.status).toBe(200);
});

test("accepts exact Unicode boundary and idempotent completion without replay overwrite", async () => {
  const context = await fixture();
  await document(context);
  const job = await claim(context),
    text = "한".repeat(200000);
  expect((await daemon(context, `${job.artifact_id}/result`, completion(job, text))).status).toBe(
    200,
  );
  expect(
    (await daemon(context, `${job.artifact_id}/result`, completion(job, "OVERWRITE"))).status,
  ).toBe(200);
  const row = z
    .object({ search_text: z.string() })
    .parse((await sql`SELECT search_text FROM assistant.artifacts WHERE id=${job.artifact_id}`)[0]);
  expect(row.search_text).toBe(text);
  const another = await document(context),
    next = await claim(context);
  expect(next.artifact_id).toBe(another.id);
  expect(
    (await daemon(context, `${next.artifact_id}/result`, completion(next, "한".repeat(200001))))
      .status,
  ).toBe(400);
  expect(
    (await daemon(context, `${next.artifact_id}/result`, completion(next, "x".repeat(1250001))))
      .status,
  ).toBe(413);
});

test("foreground preemption yields without penalty and terminal malformed stays ready", async () => {
  const context = await fixture(),
    original = await document(context),
    job = await claim(context);
  await sql`UPDATE assistant.vms SET control_state='user' WHERE id=${context.vm}`;
  const renewed = await daemon(context, `${job.artifact_id}/lease`, {
    lease_id: job.lease_id,
    version: 1,
  });
  expect(await renewed.json()).toEqual({ continue: false });
  const state = z
    .object({ status: z.string(), failures: z.number() })
    .parse(
      (
        await sql`SELECT status,failures FROM assistant.artifact_search_jobs WHERE artifact_id=${original.id}`
      )[0],
    );
  expect(state).toEqual({ status: "pending", failures: 0 });
  expect((await daemon(context, `${job.artifact_id}/result`, completion(job))).status).toBe(409);
  await sql`UPDATE assistant.vms SET control_state='agent',last_seen_at=now() WHERE id=${context.vm}`;
  await sql`UPDATE assistant.artifact_search_jobs SET next_attempt_at=now() WHERE artifact_id=${original.id}`;
  const next = await claim(context);
  expect(
    (
      await daemon(context, `${next.artifact_id}/result`, {
        ...completion(next),
        text: null,
        code: "malformed",
      })
    ).status,
  ).toBe(200);
  const coverage = WorkSearchPage.parse(await (await json(context, "/v1/search", search)).json());
  expect(coverage.failed_document_files).toBe(1);
  expect(coverage.pending_document_files).toBe(0);
  expect((await send(context, `/v1/artifacts/${original.id}/content`)).status).toBe(200);
});

test("expired leases retry finitely and never accept stale completion", async () => {
  const context = await fixture(),
    original = await document(context);
  let stale: z.infer<typeof DocumentLease> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await claim(context);
    stale ??= job;
    await sql`UPDATE assistant.artifact_search_jobs SET lease_expires_at=now()-interval '1 second' WHERE artifact_id=${original.id}`;
    expect(envelope.parse(await (await daemon(context, "claim")).json()).job).toBeNull();
    await sql`UPDATE assistant.artifact_search_jobs SET next_attempt_at=now() WHERE artifact_id=${original.id}`;
  }
  if (!stale) throw new Error("Expected old lease");
  expect((await daemon(context, `${original.id}/result`, completion(stale))).status).toBe(409);
  const state = z
    .object({ status: z.string(), failures: z.number() })
    .parse(
      (
        await sql`SELECT status,failures FROM assistant.artifact_search_jobs WHERE artifact_id=${original.id}`
      )[0],
    );
  expect(state).toEqual({ status: "failed", failures: 3 });
  expect((await send(context, `/v1/artifacts/${original.id}/content`)).status).toBe(200);
});

test("deletion wins over completion and cancels a leased job", async () => {
  const context = await fixture(),
    original = await document(context),
    job = await claim(context);
  expect((await send(context, `/v1/artifacts/${original.id}`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect((await daemon(context, `${original.id}/result`, completion(job))).status).toBe(409);
  const row = z
    .object({ state: z.string(), search_text: z.string().nullable() })
    .parse(
      (await sql`SELECT state,search_text FROM assistant.artifacts WHERE id=${original.id}`)[0],
    );
  expect(row).toEqual({ state: "deleted", search_text: null });
});

test("scopes pending and failed coverage to conversation and task state", async () => {
  const context = await fixture();
  await document(context);
  const active = WorkSearchPage.parse(
    await (await json(context, "/v1/search", { ...search, state: "active" })).json(),
  );
  const finished = WorkSearchPage.parse(
    await (await json(context, "/v1/search", { ...search, state: "finished" })).json(),
  );
  const unrelated = WorkSearchPage.parse(
    await (
      await json(context, "/v1/search", { ...search, conversation_id: crypto.randomUUID() })
    ).json(),
  );
  expect(active.pending_document_files).toBe(0);
  expect(finished.pending_document_files).toBe(1);
  expect(unrelated.pending_document_files).toBe(0);
});

test("idempotent upload cannot duplicate work or replace indexed bytes", async () => {
  const context = await fixture(),
    original = await document(context),
    job = await claim(context);
  await daemon(context, `${original.id}/result`, completion(job));
  expect((await upload(context, { ...original, name: "paper.pdf" })).status).toBe(201);
  expect(envelope.parse(await (await daemon(context, "claim")).json()).job).toBeNull();
  expect(
    z
      .object({ count: z.coerce.number() })
      .parse(
        (
          await sql`SELECT count(*) FROM assistant.artifact_search_jobs WHERE artifact_id=${original.id}`
        )[0],
      ).count,
  ).toBe(1);
});

test("offline heartbeat and queued foreground task each prevent claims", async () => {
  const context = await fixture();
  await document(context);
  await sql`UPDATE assistant.vms SET last_seen_at=now()-interval '31 seconds' WHERE id=${context.vm}`;
  expect(envelope.parse(await (await daemon(context, "claim")).json()).job).toBeNull();
  await sql`UPDATE assistant.vms SET last_seen_at=now() WHERE id=${context.vm}`;
  await json(context, `/v1/conversations/${context.conversation}/messages`, {
    client_message_id: crypto.randomUUID(),
    content: "foreground",
  });
  expect(envelope.parse(await (await daemon(context, "claim")).json()).job).toBeNull();
});

test("transport retries stop after three failures and retain original download", async () => {
  const context = await fixture(),
    original = await document(context);
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await claim(context);
    expect(
      (
        await daemon(context, `${original.id}/result`, {
          lease_id: job.lease_id,
          version: 1,
          kind: "retry",
          code: "integrity",
        })
      ).status,
    ).toBe(200);
    await sql`UPDATE assistant.artifact_search_jobs SET next_attempt_at=now() WHERE artifact_id=${original.id}`;
  }
  const state = z
    .object({ status: z.string(), failures: z.number() })
    .parse(
      (
        await sql`SELECT status,failures FROM assistant.artifact_search_jobs WHERE artifact_id=${original.id}`
      )[0],
    );
  expect(state).toEqual({ status: "failed", failures: 3 });
  expect(
    new Uint8Array(
      await (await send(context, `/v1/artifacts/${original.id}/content`)).arrayBuffer(),
    ),
  ).toEqual(original.bytes);
});

test("result and deletion race cannot resurrect searchable text", async () => {
  const context = await fixture(),
    original = await document(context),
    job = await claim(context);
  const [completed, deleted] = await Promise.all([
    daemon(context, `${original.id}/result`, completion(job)),
    send(context, `/v1/artifacts/${original.id}`, { method: "DELETE" }),
  ]);
  expect([200, 409]).toContain(completed.status);
  expect(deleted.status).toBe(200);
  const row = z
    .object({ state: z.string(), search_text: z.string().nullable() })
    .parse(
      (await sql`SELECT state,search_text FROM assistant.artifacts WHERE id=${original.id}`)[0],
    );
  expect(row).toEqual({ state: "deleted", search_text: null });
});

test("rejects a different VM in the same workspace even with the exact lease token", async () => {
  const context = await fixture();
  await document(context);
  const job = await claim(context),
    vm = crypto.randomUUID(),
    token = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${context.workspace},'other-document-vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${context.workspace},'vm',${vm})`;
  const denied = await send(context, `/v1/daemon/artifact-index/${job.artifact_id}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(completion(job)),
  });
  expect(denied.status).toBe(409);
  expect((await daemon(context, `${job.artifact_id}/result`, completion(job))).status).toBe(200);
});
