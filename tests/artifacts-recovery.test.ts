import { expect, test } from "bun:test";
import { z } from "zod";
import { cleanupArtifacts } from "../packages/artifacts/cleanup";
import type { ArtifactStore } from "../packages/artifacts/store";
import { artifactFixture, errorCode, send, upload } from "./artifacts-fixture";

const { fixture, sql, storage } = artifactFixture();

function wrapped(
  put: ArtifactStore["put"],
  remove: ArtifactStore["delete"] = (key) => storage.delete(key),
): ArtifactStore {
  return { put, get: (key) => storage.get(key), delete: remove };
}

test("storage failure releases reservation and same immutable upload ID retries successfully", async () => {
  // Given real file storage that reports its first completed write as failed.
  let fail = true;
  const context = await fixture(
    wrapped(async (key, body, metadata) => {
      await storage.put(key, body, metadata);
      if (fail) {
        fail = false;
        throw new Error("fixture write fault");
      }
    }),
  );
  const id = crypto.randomUUID(),
    bytes = new Uint8Array([1, 2, 3]);
  // When retrying the same ID after a storage failure.
  expect((await upload(context, { id, bytes })).status).toBe(503);
  const failed = z
    .object({ state: z.string(), purged_at: z.string().nullable() })
    .parse((await sql`SELECT state,purged_at FROM assistant.artifacts WHERE id=${id}`)[0]);
  expect(failed.state).toBe("failed");
  expect(failed.purged_at).not.toBeNull();
  expect((await upload(context, { id, bytes })).status).toBe(201);
  // Then actual stored bytes exist once with the original immutable identity.
  expect(
    new Uint8Array(await (await send(context, `/v1/artifacts/${id}/content`)).arrayBuffer()),
  ).toEqual(bytes);
  expect(
    z
      .object({ bytes: z.coerce.number() })
      .parse(
        (
          await sql`SELECT sum(bytes) AS bytes FROM assistant.artifacts WHERE workspace_id=${context.workspace} AND purged_at IS NULL`
        )[0],
      ).bytes,
  ).toBe(bytes.length);
});

test("concurrent changed bytes conflict and active identical lease cannot duplicate upload", async () => {
  // Given one reserved upload paused before real storage writes.
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const context = await fixture(
    wrapped(async (key, body, metadata) => {
      started.resolve();
      await finish.promise;
      await storage.put(key, body, metadata);
    }),
  );
  const id = crypto.randomUUID(),
    bytes = new Uint8Array([8, 9]);
  const first = upload(context, { id, bytes });
  await started.promise;
  try {
    // When same UUID is submitted with different and identical bytes while active.
    const changed = await upload(context, { id, bytes: new Uint8Array([5]) });
    expect(errorCode.parse(await changed.json()).error.code).toBe("idempotency_conflict");
    const duplicate = await upload(context, { id, bytes });
    expect(errorCode.parse(await duplicate.json()).error.code).toBe("artifact_uploading");
  } finally {
    finish.resolve();
  }
  // Then first upload still stores its exact bytes.
  expect((await first).status).toBe(201);
  expect(
    new Uint8Array(await (await send(context, `/v1/artifacts/${id}/content`)).arrayBuffer()),
  ).toEqual(bytes);
});

test("expired lease retries and old completion cannot delete the newer ready object", async () => {
  // Given an abandoned first store request held open beyond its durable lease.
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  let calls = 0;
  const context = await fixture(
    wrapped(async (key, body, metadata) => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await finish.promise;
      }
      await storage.put(key, body, metadata);
    }),
  );
  const id = crypto.randomUUID(),
    bytes = new Uint8Array([21, 22]);
  const old = upload(context, { id, bytes });
  await started.promise;
  await sql`UPDATE assistant.artifacts SET lease_expires_at=now()-interval '1 second' WHERE id=${id}`;
  try {
    // When same ID takes a new lease and finishes before the old attempt.
    expect((await upload(context, { id, bytes })).status).toBe(201);
  } finally {
    finish.resolve();
  }
  expect((await old).status).toBe(409);
  // Then stale compensation leaves the newer file ready and byte-exact.
  expect(
    z
      .object({ state: z.string() })
      .parse((await sql`SELECT state FROM assistant.artifacts WHERE id=${id}`)[0]).state,
  ).toBe("ready");
  expect(
    new Uint8Array(await (await send(context, `/v1/artifacts/${id}/content`)).arrayBuffer()),
  ).toEqual(bytes);
});

test("late same-lease write after expiry cleanup and user deletion is physically purged", async () => {
  // Given a slow real store request, then expired lease cleanup and explicit deletion.
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const context = await fixture(
    wrapped(async (key, body, metadata) => {
      started.resolve();
      await finish.promise;
      await storage.put(key, body, metadata);
    }),
  );
  const id = crypto.randomUUID(),
    bytes = new Uint8Array([31, 32]);
  const pending = upload(context, { id, bytes });
  await started.promise;
  await sql`UPDATE assistant.artifacts SET lease_expires_at=now()-interval '1 second' WHERE id=${id}`;
  await cleanupArtifacts(sql, storage);
  expect((await send(context, `/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200);
  // When old put finishes after its object had already been purged.
  finish.resolve();
  expect((await pending).status).toBe(409);
  // Then original tombstone remains and the late physical object is removed too.
  expect(await storage.get(`${context.workspace}/${id}`)).toBeNull();
  expect((await send(context, `/v1/artifacts/${id}/content`)).status).toBe(404);
  const row = z
    .object({ state: z.string(), purged_at: z.string().nullable() })
    .parse((await sql`SELECT state,purged_at FROM assistant.artifacts WHERE id=${id}`)[0]);
  expect(row.state).toBe("deleted");
  expect(row.purged_at).not.toBeNull();
});

test("deletion failure hides file and holds quota until real cleanup succeeds", async () => {
  // Given actual bytes and an object delete failure.
  let fail = true;
  const context = await fixture(
    wrapped(
      (key, body, metadata) => storage.put(key, body, metadata),
      async (key) => {
        if (fail) throw new Error("fixture delete fault");
        await storage.delete(key);
      },
    ),
  );
  const id = crypto.randomUUID(),
    bytes = new Uint8Array([41]);
  await upload(context, { id, bytes });
  // When delete fails then background cleanup retries against real storage.
  expect((await send(context, `/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(503);
  expect((await send(context, `/v1/artifacts/${id}/content`)).status).toBe(404);
  expect(
    z
      .object({ purged_at: z.string().nullable() })
      .parse((await sql`SELECT purged_at FROM assistant.artifacts WHERE id=${id}`)[0]).purged_at,
  ).toBeNull();
  fail = false;
  await cleanupArtifacts(sql, storage);
  // Then underlying object is gone and quota reservation is released.
  expect(await storage.get(`${context.workspace}/${id}`)).toBeNull();
  expect(
    z
      .object({ purged_at: z.string().nullable() })
      .parse((await sql`SELECT purged_at FROM assistant.artifacts WHERE id=${id}`)[0]).purged_at,
  ).not.toBeNull();
});

test("older lease completing after a newer ready file was deleted cannot resurrect bytes", async () => {
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  let calls = 0;
  const context = await fixture(
    wrapped(async (key, body, metadata) => {
      if (++calls === 1) {
        started.resolve();
        await finish.promise;
      }
      await storage.put(key, body, metadata);
    }),
  );
  const id = crypto.randomUUID(),
    bytes = new Uint8Array([51]);
  const old = upload(context, { id, bytes });
  await started.promise;
  await sql`UPDATE assistant.artifacts SET lease_expires_at=now()-interval '1 second' WHERE id=${id}`;
  try {
    expect((await upload(context, { id, bytes })).status).toBe(201);
    expect((await send(context, `/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200);
  } finally {
    finish.resolve();
  }
  expect((await old).status).toBe(409);
  expect(await storage.get(`${context.workspace}/${id}`)).toBeNull();
  expect((await send(context, `/v1/artifacts/${id}/content`)).status).toBe(404);
});
