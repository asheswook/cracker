import { afterAll, expect, test } from 'bun:test';
import { createNotificationFixtures } from './native-notifications-fixture';
import { tickAttention } from '../packages/attention/coordinator';
import { executionPolicy } from '../services/control/repository/execution-policy';
import { applyPolicy, offered } from '../services/daemon/read-only';

const { sql, fixture, cleanup } = createNotificationFixtures();
const created: string[] = [];
afterAll(async () => {
  for (const workspace of created) {
    await sql`UPDATE assistant.workspaces SET default_conversation_id=NULL WHERE id=${workspace}`;
    await sql`DELETE FROM assistant.meeting_preps WHERE workspace_id=${workspace}`;
    await sql`DELETE FROM assistant.attention_brief_runs WHERE workspace_id=${workspace}`;
    await sql`DELETE FROM assistant.attention_briefs WHERE workspace_id=${workspace}`;
    await sql`DELETE FROM assistant.attention_settings WHERE workspace_id=${workspace}`;
  }
  await cleanup();
});

async function planner() {
  const f = await fixture();
  created.push(f.workspace);
  // Same workspace/default-conversation setup as attention-coordinator, with an owned daemon run for route tests.
  await sql`UPDATE assistant.workspaces SET default_conversation_id=${f.conversation} WHERE id=${f.workspace}`;
  await sql`INSERT INTO assistant.attention_settings(workspace_id,brief_enabled) VALUES(${f.workspace},false)`;
  await sql`INSERT INTO assistant.attention_brief_runs(task_id,workspace_id,local_date) VALUES(${f.task},${f.workspace},'2026-10-27')`;
  const plan = (meetings: object[]) => f.daemonPost(`/v1/daemon/context/${f.run}/meeting-prep`, { meetings });
  const row = async () => (await sql`SELECT * FROM assistant.meeting_preps WHERE workspace_id=${f.workspace} ORDER BY created_at LIMIT 1`)[0];
  return { ...f, plan, row };
}
const at = (time: string) => new Date(`2026-10-27T${time}:00+09:00`);
const meeting = (extra: object = {}) => ({ event_key: 'calendar-event-1', title: '출시 검토', starts_at: at('14:00').toISOString(),
  attendees: ['민수 <minsu@example.com>'], note_hint: '지난번 출시 기준과 미해결 질문', ...extra });

test('route plans; before the window nothing runs; concurrent/repeated ticks dispatch once with brief policy', async () => {
  const f = await planner();
  expect((await f.plan([meeting()])).status).toBe(200);
  await tickAttention(sql, at('13:47'));
  expect((await f.row())?.['state']).toBe('planned');
  expect((await f.row())?.['task_id']).toBeNull();
  await Promise.all([tickAttention(sql, at('13:48')), tickAttention(sql, at('13:50'))]);
  await tickAttention(sql, at('13:51'));
  const row = await f.row(), taskId = String(row?.['task_id']);
  expect(row?.['state']).toBe('dispatched');
  expect((await sql`SELECT count(*)::int AS n FROM assistant.tasks WHERE workspace_id=${f.workspace} AND lane='background'`)[0]?.['n']).toBe(1);
  const task = (await sql`SELECT title,objective FROM assistant.tasks WHERE id=${taskId}`)[0];
  expect(task?.['title']).toBe('회의 준비 · 출시 검토');
  expect(String(task?.['objective'])).toContain('If it moved, was cancelled, or cannot be verified, reply exactly NO_REPORT');
  expect(String(task?.['objective'])).toContain('Never invent');
  expect(await executionPolicy(sql, f.workspace, taskId)).toEqual({ run_policy: 'brief', calendar_servers: [] });
  // Already dispatched meetings cannot be re-armed by another brief.
  await f.plan([meeting({ title: '다시 계획', starts_at: at('15:00').toISOString() })]);
  expect(new Date(String((await f.row())?.['starts_at'])).toISOString()).toBe(at('14:00').toISOString());
});

test('past meetings are skipped, and a meeting that has just started is never dispatched', async () => {
  const f = await planner();
  await f.plan([meeting()]);
  await tickAttention(sql, at('14:00'));
  expect((await f.row())?.['task_id']).toBeNull();
  await tickAttention(sql, at('14:06'));
  expect((await f.row())?.['state']).toBe('skipped');
  expect((await f.row())?.['task_id']).toBeNull();
});

test('re-planning moves a planned meeting (even across midnight), updates metadata, and retains one row', async () => {
  const f = await planner();
  await f.plan([meeting()]);
  const moved = '2026-10-28T14:30:00+09:00';
  await f.plan([meeting({ title: '변경된 출시 검토', starts_at: moved, attendees: ['지수'], note_hint: '' })]);
  const row = await f.row();
  expect(new Date(String(row?.['starts_at'])).toISOString()).toBe(new Date(moved).toISOString());
  expect(row?.['title']).toBe('변경된 출시 검토');
  expect(row?.['attendees']).toEqual(['지수']);
  expect(row?.['note_hint']).toBe('');
  expect((await sql`SELECT count(*)::int AS n FROM assistant.meeting_preps WHERE workspace_id=${f.workspace}`)[0]?.['n']).toBe(1);
  await tickAttention(sql, at('13:50'));
  expect((await f.row())?.['state']).toBe('planned');
});

test('planning is brief-only, validates timestamps, and cannot use another workspace/run', async () => {
  const f = await planner(), other = await planner();
  expect((await f.plan([meeting({ starts_at: 'not-an-iso-time' })])).status).toBe(400);
  expect((await f.daemonPost(`/v1/daemon/context/${other.run}/meeting-prep`, { meetings: [meeting()] })).status).toBe(404);
  await sql`DELETE FROM assistant.attention_brief_runs WHERE task_id=${f.task}`;
  expect((await f.plan([meeting()])).status).toBe(403);
  expect(offered('brief', 'plan_meeting_prep')).toBe(true);
  expect(offered('read_only', 'plan_meeting_prep')).toBe(false);
  expect(applyPolicy('read_only', 'plan_meeting_prep', '{}')).toHaveProperty('refused');
});

async function publishingPrep() {
  const f = await planner();
  await f.register();
  await sql`DELETE FROM assistant.attention_brief_runs WHERE task_id=${f.task}`;
  await sql`UPDATE assistant.tasks SET lane='background',origin='responsibility' WHERE id=${f.task}`;
  await sql`INSERT INTO assistant.meeting_preps(workspace_id,event_key,title,starts_at,conversation_id,state,task_id)
    VALUES(${f.workspace},'publish-event','출시 검토',now()+interval '10 minutes',${f.conversation},'dispatched',${f.task})`;
  const say = (content: string, extra: object = {}) => f.post({ kind: 'message', event_id: crypto.randomUUID(), run_id: f.run, content, phase: 'final_answer', ...extra });
  const visible = () => sql`SELECT content,notify FROM assistant.messages WHERE task_id=${f.task} AND NOT hidden`;
  const pushes = () => sql`SELECT id FROM assistant.notification_intents WHERE workspace_id=${f.workspace}`;
  return { ...f, say, visible, pushes };
}

test('meeting prep reuses brief publication: only one normal message and one push, no intermediate cards', async () => {
  const f = await publishingPrep();
  await f.say('진행 중', { phase: 'commentary' });
  await f.say('질문', { blocks: [{ kind: 'choice', id: 'c1', question: 'Q', options: [{ id: 'a', label: 'A' }, { id: 'later', label: '나중에' }] }] });
  const content = '민수와 출시 검토가 있어요. 지난번 합의한 오류율 기준과 남은 승인 여부를 확인하세요.';
  expect((await f.say(content)).status).toBe(200);
  await f.say('중복 보고');
  expect((await f.visible()).map(r => [r['content'], r['notify']])).toEqual([[content, true]]);
  expect((await f.pushes()).length).toBe(1);
  expect((await f.row())?.['state']).toBe('done');
  expect((await sql`SELECT count(*)::int AS n FROM assistant.card_states WHERE workspace_id=${f.workspace}`)[0]?.['n']).toBe(0);
  expect((await executionPolicy(sql, f.workspace, f.task)).run_policy).toBe('brief');
});

test('NO_REPORT (including moved/cancelled/no useful knowledge) stays silent; late preparation stays silent', async () => {
  for (const late of [false, true]) {
    const f = await publishingPrep();
    if (late) await sql`UPDATE assistant.meeting_preps SET starts_at=now()-interval '1 minute' WHERE workspace_id=${f.workspace}`;
    await f.say(late ? '너무 늦은 회의 준비' : 'NO_REPORT');
    expect((await f.visible()).length).toBe(0);
    expect((await f.pushes()).length).toBe(0);
    expect((await f.row())?.['state']).toBe('skipped');
  }
});
