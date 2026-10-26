import { afterAll, beforeAll, expect, test } from "bun:test";
import ky from "ky";
import { z } from "zod";
import { createApp } from "../services/control/app.ts";
import { createDatabase } from "../services/control/db.ts";
import { hashToken } from "../services/control/auth.ts";
import { DaemonPoll } from "../packages/protocol/index.ts";
import { enroll } from "../services/daemon/proactive.ts";
const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), token = crypto.randomUUID()+crypto.randomUUID();
const app = createApp(sql), server = Bun.serve({ port: 0, fetch: app.fetch });
const http = ky.create({ prefixUrl: server.url.href, headers: { Authorization: `Bearer ${token}` }, retry: 0 });
beforeAll(async () => {
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'proactive-enrollment')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${workspace},'vm',${vm})`;
});
afterAll(async () => { await sql`UPDATE assistant.schedules SET status='cancelled' WHERE workspace_id=${workspace} AND status='pending'`; await sql`UPDATE assistant.responsibilities SET state='cancelled' WHERE workspace_id=${workspace}`; await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`; await server.stop(true); await sql.end(); });
async function fixture() {
  await sql`UPDATE assistant.runs SET state='succeeded',updated_at=now() WHERE workspace_id=${workspace}`;
  await sql`UPDATE assistant.tasks SET state='succeeded' WHERE workspace_id=${workspace}`;
  const conversation = crypto.randomUUID(), task = crypto.randomUUID(), source = crypto.randomUUID();
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'enrollment')`;
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective) VALUES(${task},${workspace},${conversation},'Watch the report')`;
  await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content) VALUES(${source},${workspace},${conversation},${task},'user','Watch the report every ten minutes and notify me of meaningful changes.')`;
  const poll = DaemonPoll.parse(await http.get('v1/daemon/poll').json());
  if (!poll.assignment) throw new TypeError('Missing assignment');
  return { runId: poll.assignment.run_id, conversationId: conversation, actionId: `${poll.assignment.run_id}:call1`, source, task };
}
function args(source: string) { return JSON.stringify({ source_message_id: source, source_quote: 'Watch the report every ten minutes and notify me of meaningful changes.', objective: 'Watch the report for meaningful changes', trigger_kind: 'periodic', due_at: null, timezone: null, task_id: null, interval_minutes: 10, until_at: null, starts_at: null }); }
test('model enrollment action persists once across repeated action delivery', async () => {
  // Given
  const scope = await fixture(), call = { name: 'create_responsibility', args: args(scope.source), signal: AbortSignal.timeout(5000) };
  // When
  const first = JSON.parse(await enroll(http, scope, call)); const repeated = JSON.parse(await enroll(http, scope, call));
  // Then
  expect(first).toEqual(repeated);
  expect(z.object({ count: z.coerce.number() }).parse((await sql`SELECT count(*) count FROM assistant.responsibilities WHERE conversation_id=${scope.conversationId}`)[0]).count).toBe(1);
});
test('assistant promise cannot authorize a responsibility', async () => {
  // Given
  const scope = await fixture(); await sql`UPDATE assistant.messages SET role='assistant' WHERE id=${scope.source}`;
  // When / Then
  await expect(enroll(http, scope, { name:'create_responsibility', args:args(scope.source), signal:AbortSignal.timeout(5000) })).rejects.toThrow('enrollment_http_409_stale_run');
});
test('terminal run cannot enroll future responsibility', async () => {
  // Given
  const scope = await fixture(); await sql`UPDATE assistant.runs SET state='unknown' WHERE id=${scope.runId}`;
  // When / Then
  await expect(enroll(http, scope, { name:'create_responsibility', args:args(scope.source), signal:AbortSignal.timeout(5000) })).rejects.toThrow('enrollment_http_409_stale_run');
});
test('unquoted user intent cannot enroll future responsibility', async () => {
  // Given
  const scope = await fixture(); await sql`UPDATE assistant.messages SET content='Hello' WHERE id=${scope.source}`;
  // When / Then
  const result = JSON.parse(await enroll(http, scope, { name:'create_responsibility', args:args(scope.source), signal:AbortSignal.timeout(5000) }));
  expect(result).toMatchObject({ kind: 'enrollment_rejected', code:'source_mismatch', persisted:false });
});

test('rejected schedule source can be corrected without duplicating durable enrollment', async () => {
  // Given
  const scope = await fixture();
  const base = { source_message_id:scope.source, source_quote:'invented quote', objective:'one reminder', due_at:new Date(Date.now()+60000).toISOString(), timezone:'UTC' };
  // When
  const rejected = JSON.parse(await enroll(http, scope, {name:'create_schedule',args:JSON.stringify(base),signal:AbortSignal.timeout(5000)}));
  const corrected = JSON.parse(await enroll(http, {...scope, actionId:scope.actionId+':corrected'}, {name:'create_schedule',args:JSON.stringify({...base,source_quote:'Watch the report every ten minutes and notify me of meaningful changes.'}),signal:AbortSignal.timeout(5000)}));
  // Then
  expect(rejected).toMatchObject({kind:'enrollment_rejected',code:'invalid_source',persisted:false});
  expect(corrected.schedule.source_message_id).toBe(scope.source);
  expect(z.object({count:z.coerce.number()}).parse((await sql`SELECT count(*) count FROM assistant.schedules WHERE conversation_id=${scope.conversationId}`)[0]).count).toBe(1);
});
