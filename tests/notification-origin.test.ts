import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { Query } from '../services/control/db';
import { enqueueMessageNotification } from '../packages/notifications/store';

for (const [origin, notify, count] of [
  ['schedule', false, 0], ['schedule', true, 1], ['user', false, 1],
  ['responsibility', false, 0], ['responsibility', true, 1],
] as const) test(`notification enqueue: ${origin}, notify=${notify}`, async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`ATTACH DATABASE ':memory:' AS assistant;
      CREATE TABLE assistant.messages(id TEXT PRIMARY KEY,workspace_id TEXT,task_id TEXT,conversation_id TEXT,role TEXT,origin TEXT,notify INTEGER);
      CREATE TABLE assistant.notification_intents(id TEXT PRIMARY KEY,workspace_id TEXT,run_id TEXT,task_id TEXT,conversation_id TEXT,message_id TEXT,outcome TEXT);
      CREATE TABLE assistant.notification_deliveries(intent_id TEXT,subscription_id TEXT,UNIQUE(intent_id,subscription_id));
      CREATE TABLE assistant.push_subscriptions(id TEXT,workspace_id TEXT,enabled INTEGER,credential_hash TEXT,session_hash TEXT);
      CREATE TABLE assistant.credentials(token_hash TEXT,revoked_at TEXT);
      CREATE TABLE assistant.browser_sessions(token_hash TEXT,revoked_at TEXT,expires_at TEXT);
      INSERT INTO assistant.push_subscriptions VALUES('subscription','workspace',true,'credential',null);
      INSERT INTO assistant.credentials VALUES('credential',null);`);
    db.query("INSERT INTO assistant.messages VALUES('message','workspace','task','conversation','assistant',?,?)").run(origin, Number(notify));
    const sql = (async (parts: TemplateStringsArray, ...values: (string | null)[]) => db.query(parts.join('?').replaceAll('now()', 'CURRENT_TIMESTAMP')).all(...values)) as unknown as Query;
    await enqueueMessageNotification(sql, 'workspace', { id: 'message', runId: 'run' });
    await enqueueMessageNotification(sql, 'workspace', { id: 'message', runId: 'run' });
    expect(db.query('SELECT * FROM assistant.notification_intents').all()).toHaveLength(count);
    expect(db.query('SELECT * FROM assistant.notification_deliveries').all()).toHaveLength(count);
  } finally { db.close(); }
});
