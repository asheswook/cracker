import { afterAll, expect, test } from 'bun:test';
import { createNotificationFixtures } from './native-notifications-fixture';
import { publishBriefMessage, tickAttention } from '../packages/attention/coordinator';
import { executionPolicy } from '../services/control/repository/execution-policy';
import { applyPolicy, offered } from '../services/daemon/read-only';

const { sql, fixture, cleanup } = createNotificationFixtures();
const created: string[] = [];
afterAll(async () => {
  for (const workspace of created) {
    await sql`UPDATE assistant.workspaces SET default_conversation_id=NULL WHERE id=${workspace}`;
    await sql`DELETE FROM assistant.meeting_prep_runs WHERE workspace_id=${workspace}`;
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
  expect((await sql`SELECT count(*)::int AS n FROM assistant.tasks t WHERE workspace_id=${f.workspace} AND lane='background'
    AND NOT EXISTS(SELECT 1 FROM assistant.meeting_prep_runs p WHERE p.task_id=t.id)`)[0]?.['n']).toBe(1);
  const task = (await sql`SELECT title,objective FROM assistant.tasks WHERE id=${taskId}`)[0];
  expect(task?.['title']).toBe('회의 준비 · 출시 검토');
  expect(String(task?.['objective'])).toContain('If it moved, was cancelled, or cannot be verified, reply exactly NO_REPORT');
  expect(String(task?.['objective'])).toContain('Never invent');
  expect(await executionPolicy(sql, f.workspace, taskId)).toEqual({ run_policy: 'brief', calendar_servers: [] });
  // Repeating the same calendar snapshot does not re-arm the existing attempt.
  await f.plan([meeting()]);
  expect((await f.row())?.['task_id']).toBe(taskId);
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
  expect((await f.row())?.['delivered']).toBe(true);
  const expiry = (await sql`SELECT n.expires_at=p.starts_at AS matches FROM assistant.notification_intents n
    JOIN assistant.meeting_preps p ON p.message_id=n.message_id WHERE p.workspace_id=${f.workspace}`)[0];
  expect(expiry?.['matches']).toBe(true);
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
    expect((await f.row())?.['delivered']).toBe(false);
  }
});

test('quiet morning/afternoon planning runs without a brief and can never publish output', async () => {
  const f = await planner();
  await f.register();
  // A genuine no-brief day: no attention changes and morning briefs disabled.
  await sql`DELETE FROM assistant.attention_brief_runs WHERE task_id=${f.task}`;
  await tickAttention(sql, at('08:29'));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(0);
  await tickAttention(sql, at('08:30'));
  await tickAttention(sql, at('09:00'));
  const morning = (await sql`SELECT task_id,half FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`)[0];
  expect(morning?.['half']).toBe('morning');
  expect((await sql`SELECT * FROM assistant.attention_briefs WHERE workspace_id=${f.workspace}`).length).toBe(0);
  const task = String(morning?.['task_id']);
  expect((await executionPolicy(sql, f.workspace, task)).run_policy).toBe('brief');
  await sql`UPDATE assistant.tasks SET state='running' WHERE id=${task}`;
  const run = crypto.randomUUID();
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${f.workspace},${task},${f.vm},'running')`;
  const planned = await f.daemonPost(`/v1/daemon/context/${run}/meeting-prep`, { meetings: [meeting()] });
  expect(planned.status).toBe(200);
  for (const content of ['잘못 작성한 브리핑', 'NO_REPORT']) expect((await f.post({ kind: 'message', event_id: crypto.randomUUID(), run_id: run, content, phase: 'final_answer' })).status).toBe(200);
  expect((await sql`SELECT * FROM assistant.messages WHERE task_id=${task} AND NOT hidden`).length).toBe(0);
  expect((await sql`SELECT * FROM assistant.notification_intents WHERE workspace_id=${f.workspace}`).length).toBe(0);
  // The planning task is also excluded from read_attention's task list (no self-generated news).
  const { attention: readAttention } = await import('../packages/attention/store');
  expect((await readAttention(sql, f.workspace)).in_progress.some(i => i.id === `task:${task}`)).toBe(false);
  await tickAttention(sql, at('13:00'));
  await tickAttention(sql, at('13:01'));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(2);
});

test('a failed quiet planner retries once, only after thirty minutes, and keeps the old attempt silent', async () => {
  const f = await planner();
  await sql`DELETE FROM assistant.attention_brief_runs WHERE task_id=${f.task}`;
  const attempt = async () => String((await sql`SELECT task_id FROM assistant.meeting_prep_runs
    WHERE workspace_id=${f.workspace} AND local_date='2026-10-27' AND half='morning'`)[0]?.['task_id']);
  await tickAttention(sql, at('08:30'));
  const first = await attempt();
  await sql`UPDATE assistant.tasks SET state='failed',updated_at=${at('08:35')} WHERE id=${first}`;
  await tickAttention(sql, at('09:04'));
  expect(await attempt()).toBe(first);
  await Promise.all([tickAttention(sql, at('09:05')), tickAttention(sql, at('09:05'))]);
  const retry = await attempt();
  expect(retry).not.toBe(first);
  expect((await sql`SELECT count(*)::int AS n FROM assistant.tasks WHERE workspace_id=${f.workspace}
    AND title='회의 준비 계획'`)[0]?.['n']).toBe(2);
  expect((await executionPolicy(sql, f.workspace, first)).run_policy).toBe('brief');
  expect(await publishBriefMessage(sql, f.workspace, first, { final: true, empty: false }))
    .toEqual({ hidden: true, notify: false, push: false });
  await sql`UPDATE assistant.tasks SET state='failed',updated_at=${at('09:10')} WHERE id=${retry}`;
  await tickAttention(sql, at('09:40'));
  await tickAttention(sql, at('12:59'));
  expect(await attempt()).toBe(retry);
  expect((await sql`SELECT count(*)::int AS n FROM assistant.tasks WHERE workspace_id=${f.workspace}
    AND title='회의 준비 계획'`)[0]?.['n']).toBe(2);
  // Exhausting the morning retry budget does not consume the afternoon's planning slot.
  await tickAttention(sql, at('13:00'));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(2);
});

test.each(['running', 'succeeded', 'failed'])('a successful quiet plan call completes its half-day even when the task is %s', async state => {
  const f = await planner();
  await sql`DELETE FROM assistant.attention_brief_runs WHERE task_id=${f.task}`;
  await tickAttention(sql, at('08:30'));
  const first = (await sql`SELECT task_id FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`)[0]?.['task_id'];
  const run = crypto.randomUUID();
  await sql`UPDATE assistant.tasks SET state='running' WHERE id=${first}`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${f.workspace},${first},${f.vm},'running')`;
  expect((await f.daemonPost(`/v1/daemon/context/${run}/meeting-prep`, { meetings: [] })).status).toBe(200);
  const planned = (await sql`SELECT payload FROM assistant.events WHERE workspace_id=${f.workspace} AND kind='meeting_prep.planned'`)[0];
  expect(planned?.['payload']).toMatchObject({ task_id: first, local_date: '2026-10-27', half: 'morning' });
  await sql`UPDATE assistant.tasks SET state=${state},updated_at=${at('08:35')} WHERE id=${first}`;
  await tickAttention(sql, at('09:05'));
  await tickAttention(sql, at('12:59'));
  expect((await sql`SELECT count(*)::int AS n FROM assistant.tasks WHERE workspace_id=${f.workspace}
    AND title='회의 준비 계획'`)[0]?.['n']).toBe(1);
  await tickAttention(sql, at('13:00'));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(2);
});

test('NO_REPORT task success without a plan retries once after thirty minutes', async () => {
  const f = await planner();
  await sql`DELETE FROM assistant.attention_brief_runs WHERE task_id=${f.task}`;
  const attempt = async () => String((await sql`SELECT task_id FROM assistant.meeting_prep_runs
    WHERE workspace_id=${f.workspace} AND local_date='2026-10-27' AND half='morning'`)[0]?.['task_id']);
  await tickAttention(sql, at('08:30'));
  const first = await attempt(), run = crypto.randomUUID();
  await sql`UPDATE assistant.tasks SET state='running' WHERE id=${first}`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${f.workspace},${first},${f.vm},'running')`;
  expect((await f.post({ kind: 'message', event_id: crypto.randomUUID(), run_id: run, content: 'NO_REPORT', phase: 'final_answer' })).status).toBe(200);
  await sql`UPDATE assistant.tasks SET state='succeeded',updated_at=${at('08:35')} WHERE id=${first}`;
  expect((await sql`SELECT * FROM assistant.events WHERE workspace_id=${f.workspace} AND kind='meeting_prep.planned'`).length).toBe(0);
  await tickAttention(sql, at('09:04'));
  expect(await attempt()).toBe(first);
  await Promise.all([tickAttention(sql, at('09:05')), tickAttention(sql, at('09:05'))]);
  const retry = await attempt();
  expect(retry).not.toBe(first);
  await sql`UPDATE assistant.tasks SET state='succeeded',updated_at=${at('09:10')} WHERE id=${retry}`;
  await tickAttention(sql, at('09:40'));
  await tickAttention(sql, at('12:59'));
  expect(await attempt()).toBe(retry);
  expect((await sql`SELECT count(*)::int AS n FROM assistant.tasks WHERE workspace_id=${f.workspace}
    AND title='회의 준비 계획'`)[0]?.['n']).toBe(2);
  expect((await sql`SELECT * FROM assistant.messages WHERE workspace_id=${f.workspace} AND task_id=${first} AND NOT hidden`).length).toBe(0);
});

test('only a successful plan call by the same half-day brief replaces quiet planning, including an empty plan', async () => {
  for (const half of ['morning', 'afternoon']) {
    const f = await planner(), start = half === 'morning' ? '08:30' : '13:00';
    await sql`UPDATE assistant.attention_brief_runs SET created_at=${at(start)} WHERE task_id=${f.task}`;
    // Invalid input cannot consume the slot.
    expect((await f.plan([meeting({ starts_at: 'invalid' })])).status).toBe(400);
    expect((await sql`SELECT * FROM assistant.events WHERE workspace_id=${f.workspace} AND kind='meeting_prep.planned'`).length).toBe(0);
    expect((await f.plan([])).status).toBe(200);
    const planned = (await sql`SELECT payload FROM assistant.events WHERE workspace_id=${f.workspace} AND kind='meeting_prep.planned'`)[0];
    expect(planned?.['payload']).toMatchObject({ task_id: f.task, local_date: '2026-10-27', half });
    await tickAttention(sql, at(start));
    expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(0);
    await tickAttention(sql, half === 'morning' ? at('13:00') : new Date('2026-10-28T08:30:00+09:00'));
    expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(1);
  }
});

test('a brief that never planned meetings does not consume quiet planning', async () => {
  const f = await planner();
  await sql`UPDATE assistant.attention_brief_runs SET created_at=${at('08:30')} WHERE task_id=${f.task}`;
  await sql`UPDATE assistant.tasks SET state='succeeded' WHERE id=${f.task}`;
  await tickAttention(sql, at('09:00'));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(1);
});

test.each(['morning', 'afternoon'])('an in-progress %s brief gets fifteen minutes to plan before quiet fallback', async half => {
  const f = await planner(), start = at(half === 'morning' ? '08:30' : '13:00');
  await sql`UPDATE assistant.attention_brief_runs SET created_at=${start} WHERE task_id=${f.task}`;
  await tickAttention(sql, start);
  await tickAttention(sql, new Date(start.getTime() + 15 * 60_000 - 1));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(0);
  await tickAttention(sql, new Date(start.getTime() + 15 * 60_000));
  expect((await sql`SELECT half FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`)[0]?.['half']).toBe(half);
});

test('a brief can complete planning during its grace period without a quiet fallback', async () => {
  const f = await planner();
  await sql`UPDATE assistant.attention_brief_runs SET created_at=${at('08:30')} WHERE task_id=${f.task}`;
  await tickAttention(sql, at('08:30'));
  expect((await f.plan([])).status).toBe(200);
  await tickAttention(sql, at('08:45'));
  expect((await sql`SELECT * FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`).length).toBe(0);
});

test('a still-running morning brief does not delay afternoon quiet planning', async () => {
  const f = await planner();
  await sql`UPDATE assistant.attention_brief_runs SET created_at=${at('12:59')} WHERE task_id=${f.task}`;
  await tickAttention(sql, at('13:00'));
  expect((await sql`SELECT half FROM assistant.meeting_prep_runs WHERE workspace_id=${f.workspace}`)[0]?.['half']).toBe('afternoon');
});

test('moving an undelivered dispatched/skipped meeting re-arms it and hides the old attempt', async () => {
  for (const state of ['dispatched', 'skipped']) {
    const f = await publishingPrep();
    await sql`UPDATE assistant.meeting_preps SET state=${state} WHERE workspace_id=${f.workspace}`;
    const old = await f.row(), moved = new Date(new Date(String(old?.['starts_at'])).getTime() + 3_600_000);
    expect((await f.plan([meeting({ event_key: 'publish-event', starts_at: moved.toISOString() })])).status).toBe(200);
    expect((await f.row())?.['state']).toBe('planned');
    expect((await f.row())?.['task_id']).toBeNull();
    await f.say('이전 시각의 오래된 보고');
    expect((await f.visible()).length).toBe(0);
    expect((await executionPolicy(sql, f.workspace, f.task)).run_policy).toBe('brief');
    await tickAttention(sql, new Date(moved.getTime() - 600_000));
    expect((await f.row())?.['state']).toBe('dispatched');
    expect((await f.row())?.['task_id']).not.toBe(f.task);
  }
});

test('delivered meeting rows never re-arm; later objectives include already-said notes and 2–3 sentence guidance', async () => {
  const f = await publishingPrep(), content = '민수와 출시 검토입니다. 오류율 기준을 확인하고 승인 자료를 가져가세요.';
  await f.say(content);
  const before = await f.row(), moved = new Date(new Date(String(before?.['starts_at'])).getTime() + 600_000);
  await f.plan([meeting({ event_key: 'publish-event', starts_at: moved.toISOString() })]);
  expect((await f.row())?.['state']).toBe('done');
  expect((await f.row())?.['task_id']).toBe(f.task);
  expect(String((await f.row())?.['starts_at'])).toBe(String(before?.['starts_at']));
  const next = new Date(Date.now() + 660_000);
  await f.plan([meeting({ event_key: 'different-meeting', starts_at: next.toISOString() })]);
  await tickAttention(sql, new Date());
  const task = (await sql`SELECT t.objective FROM assistant.meeting_preps p JOIN assistant.tasks t ON t.id=p.task_id
    WHERE p.workspace_id=${f.workspace} AND p.event_key='different-meeting'`)[0];
  expect(String(task?.['objective'])).toContain(content);
  expect(String(task?.['objective'])).toContain('2–3 sentences');
  expect(String(task?.['objective'])).toContain('Do not repeat');
});
