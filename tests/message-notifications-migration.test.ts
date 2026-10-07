import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createDatabase } from "../services/control/db.ts";

test("migration defaults existing workspaces on and suppresses only undelivered legacy history", async () => {
  const url = new URL(
    process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
  );
  if (!["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error("Migration fixture requires local PostgreSQL");
  url.pathname = "/postgres";
  const admin = createDatabase(url.href);
  const name = `notification_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const sql = createDatabase(url.href);
  try {
    await sql`CREATE SCHEMA assistant`;
    const files = (await readdir(new URL("../infra/migrations", import.meta.url)))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files.filter((file) => file < "026"))
      await sql.unsafe(
        await Bun.file(new URL(`../infra/migrations/${file}`, import.meta.url)).text(),
      );
    const workspace = crypto.randomUUID(),
      vm = crypto.randomUUID(),
      conversation = crypto.randomUUID(),
      task = crypto.randomUUID(),
      run = crypto.randomUUID(),
      subscription = crypto.randomUUID();
    await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'migration-fixture')`;
    await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
    await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'fixture')`;
    await sql`INSERT INTO tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation},'fixture')`;
    await sql`INSERT INTO runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
    await sql`INSERT INTO credentials(token_hash,workspace_id,role) VALUES(${workspace},${workspace},'client')`;
    await sql`INSERT INTO push_subscriptions(id,workspace_id,credential_hash,installation_id,subscription_cipher) VALUES(${subscription},${workspace},${workspace},${crypto.randomUUID()},'synthetic')`;
    for (const state of ["pending", "leased", "accepted", "failed"]) {
      const intent = crypto.randomUUID();
      await sql`INSERT INTO notification_intents(id,workspace_id,run_id,task_id,conversation_id,outcome) VALUES(${intent},${workspace},${run},${task},${conversation},'succeeded')`;
      await sql`INSERT INTO notification_deliveries(intent_id,subscription_id,state) VALUES(${intent},${subscription},${state})`;
    }
    await sql.unsafe(
      await Bun.file(
        new URL("../infra/migrations/026_message_notifications.sql", import.meta.url),
      ).text(),
    );
    expect(
      (await sql`SELECT notification_show_content FROM workspaces WHERE id=${workspace}`)[0]?.[
        "notification_show_content"
      ],
    ).toBe(true);
    expect(
      (await sql`SELECT state FROM notification_deliveries ORDER BY state`).map(
        (row) => row["state"],
      ),
    ).toEqual(["accepted", "failed", "suppressed", "suppressed"]);
    expect(await sql`SELECT id FROM notification_intents`).toHaveLength(4);
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
