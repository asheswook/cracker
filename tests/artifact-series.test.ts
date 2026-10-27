import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import ky from "ky";
import { artifactFixture, json, send } from "./artifacts-fixture";
import { TaskArtifacts, publishArtifactTool, readArtifactTool } from "../services/daemon/artifacts";
import { applyPolicy, offered } from "../services/daemon/read-only";
import { briefView } from "../packages/attention/coordinator";
import { ARTIFACT_READ_BYTES } from "../packages/artifacts/series";

const { fixture, sql, directory } = artifactFixture();
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(async () => { for (const server of servers) await server.stop(true); });

async function routine(lane: 'foreground' | 'background' = 'background') {
  const context = await fixture(), task = crypto.randomUUID(), run = crypto.randomUUID();
  await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state,lane)
    VALUES(${task},${context.workspace},${context.conversation},'매일 경쟁사 가격표 갱신','running',${lane})`;
  await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id,state)
    VALUES(${run},${context.workspace},${task},${context.vm},'running')`;
  const server = Bun.serve({ port: 0, fetch: context.app.fetch });
  servers.push(server);
  const artifacts = await TaskArtifacts.create({ http: ky.create({ prefixUrl: server.url.href,
    headers: { Authorization: `Bearer ${context.vmToken}` }, retry: 0 }), runId: run,
    conversationId: context.conversation, root: join(directory, 'runs') });
  const publish = async (series: string | null, change_summary: string | null, content = 'company,price\nA,10000', media_type = 'text/csv', updates: string | null = null) => {
    await Bun.write(join(artifacts.outputDirectory, 'prices.csv'), content);
    return artifacts.publish(JSON.stringify({ path: 'prices.csv', name: 'prices.csv', media_type, series, change_summary, updates }), AbortSignal.timeout(5000));
  };
  const link = async (artifact: string, options: { hidden?: boolean; role?: 'assistant' | 'user'; qa?: boolean; result?: boolean } = {}) => {
    let messageTask = task;
    if (options.qa) {
      messageTask = crypto.randomUUID();
      await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state)
        VALUES(${messageTask},${context.workspace},${context.conversation},'  QA 가격표 검증','succeeded')`;
    }
    const message = crypto.randomUUID(), blocks = options.result ? [{ kind: 'result', action: 'updated', channel: 'CSV', target: null, title: '가격표 갱신', body: null, url: null, at: null }] : null;
    await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content,hidden,blocks)
      VALUES(${message},${context.workspace},${context.conversation},${messageTask},${options.role ?? 'assistant'},'결과물',${options.hidden ?? false},${blocks ? JSON.stringify(blocks) : null}::text::jsonb)`;
    await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position)
      VALUES(${context.workspace},${context.conversation},${message},${artifact},0)`;
    return message;
  };
  return { context, artifacts, publish, run, link };
}

test('routine publishes a living series, links v2, and serializes revision metadata in messages', async () => {
  const { context, publish } = await routine();
  const first = await publish('경쟁사 가격표', '첫 가격표');
  const second = await publish('경쟁사 가격표', 'A사 3,000원 인하, 신규 C사 추가', 'company,price\nA,7000\nC,8000');
  expect(first.series_key).toBe('경쟁사 가격표');
  expect(first.previous_id).toBeNull();
  expect(second.previous_id).toBe(first.id);
  expect(second.change_summary).toBe('A사 3,000원 인하, 신규 C사 추가');
  expect((await sql`SELECT previous_id,change_summary FROM assistant.artifacts WHERE id=${second.id}`)[0])
    .toMatchObject({ previous_id: first.id, change_summary: second.change_summary });
  const response = await json(context, `/v1/conversations/${context.conversation}/messages`, {
    client_message_id: crypto.randomUUID(), content: '', attachment_ids: [second.id],
  });
  const body = await response.json() as { message: { attachments: unknown[] } };
  expect(body.message.attachments[0]).toMatchObject({ series_key: '경쟁사 가격표', previous_id: first.id, change_summary: second.change_summary });
  const unrelated = await publish(null, null);
  expect(unrelated.previous_id).toBeNull();
});

test.each(['foreground', 'background'] as const)('read_artifact reads latest or exact text in a %s run', async lane => {
  const { artifacts, publish, context, run } = await routine(lane);
  const first = await publish('가격표', '첫 버전', 'A,10000');
  const second = await publish('가격표', 'A사 3,000원 인하', 'A,7000');
  const latest = JSON.parse(await artifacts.read(JSON.stringify({ series: '가격표' }), AbortSignal.timeout(5000)));
  expect(latest).toMatchObject({ artifact_id: second.id, artifact: { id: second.id }, content: 'A,7000', change_summary: 'A사 3,000원 인하' });
  const prior = JSON.parse(await artifacts.read(JSON.stringify({ artifact_id: first.id }), AbortSignal.timeout(5000)));
  expect(prior.content).toBe('A,10000');
  const alien = await routine();
  const denied = await send(alien.context, `/v1/daemon/artifacts/read?run_id=${alien.run}&artifact_id=${first.id}`, {
    headers: { Authorization: `Bearer ${alien.context.vmToken}` },
  });
  expect(denied.status).toBe(404);
  const both = await send(context, `/v1/daemon/artifacts/read?run_id=${run}&series=가격표&artifact_id=${first.id}`, {
    headers: { Authorization: `Bearer ${context.vmToken}` },
  });
  expect(both.status).toBe(400);
});

test('read_artifact returns metadata only for oversized and non-text files', async () => {
  const { artifacts, publish } = await routine();
  for (const artifact of [await publish('큰 파일', '갱신', 'x'.repeat(ARTIFACT_READ_BYTES + 1), 'text/plain'),
    await publish('PDF', '갱신', '%PDF-fixture', 'application/pdf')]) {
    const result = JSON.parse(await artifacts.read(JSON.stringify({ artifact_id: artifact.id }), AbortSignal.timeout(5000)));
    expect(result.artifact.id).toBe(artifact.id);
    expect(result.content).toBeNull();
    expect(result.change_summary).toBe('갱신');
  }
});

test('brief aggregates visible changes newest first once per series and excludes unchanged, blank and already briefed versions', async () => {
  const { context, publish, link } = await routine();
  const before = new Date(Date.now() - 60_000), now = new Date();
  const day = now.toISOString().slice(0, 10), yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const old = await publish('지난 결과', '지난 변경');
  await link(old.id);
  await sql`UPDATE assistant.artifacts SET created_at=${new Date(before.getTime() - 60_000)} WHERE id=${old.id}`;
  await sql`INSERT INTO assistant.attention_briefs(workspace_id,local_date,state,planned_at,planned_minute,reason,settings_at,finished_at,snapshot_at)
    VALUES(${context.workspace},${yesterday}::date,'delivered',${before},540,'test',${before},${before},${before})`;
  const first = await publish('경쟁사 가격표', '첫 버전');
  const firstMessage = await link(first.id, { result: true });
  const latest = await publish('경쟁사 가격표', 'A사 3,000원 인하');
  const latestMessage = await link(latest.id, { result: true });
  const earlier = await publish('변함없는 표', '이전 변경');
  await link(earlier.id);
  await link((await publish('변함없는 표', '변화 없음')).id);
  await link((await publish('변경 없는 표', '변화 없음')).id);
  await link((await publish('빈 요약', '   ')).id);
  const view = await briefView(sql, context.workspace, day, now);
  const items = view.done.filter(item => item.id.startsWith('artifact:'));
  expect(items).toHaveLength(2);
  expect(items.find(item => item.id === `artifact:${latest.id}`)).toMatchObject({ title: '결과물 · 경쟁사 가격표: A사 3,000원 인하 · 첫 버전', message_id: latestMessage });
  expect(items.find(item => item.id === `artifact:${earlier.id}`)?.title).toBe('결과물 · 변함없는 표: 이전 변경');
  expect(view.done.some(item => item.id === `result:${firstMessage}` || item.id === `result:${latestMessage}`)).toBe(false);
});

test('updates preserves series identity regardless of name, including across conversations in the workspace', async () => {
  const { context, publish, artifacts } = await routine();
  const first = await publish('경쟁사 가격표', '첫 버전');
  const read = JSON.parse(await artifacts.read(JSON.stringify({ series: '경쟁사 가격표' }), AbortSignal.timeout(5000)));
  const second = await publish('다른 이름', '가격 인하', 'A,7000', 'text/csv', read.artifact_id);
  const third = await publish(null, '새 경쟁사', 'A,7000\nB,8000', 'text/csv', first.id);
  expect(second).toMatchObject({ series_key: '경쟁사 가격표', previous_id: first.id });
  expect(third).toMatchObject({ series_key: '경쟁사 가격표', previous_id: second.id });
  const conversation = crypto.randomUUID();
  await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${context.workspace},'다른 대화')`;
  const response = await send(context, `/v1/conversations/${conversation}/artifacts`, { method: 'POST', headers: {
    'X-Artifact-Id': crypto.randomUUID(), 'X-Artifact-Name': 'cross.csv', 'X-Artifact-Updates': third.id,
    'X-Artifact-Series': encodeURIComponent('새 이름'), 'Content-Type': 'text/csv',
  }, body: 'A,6000' });
  expect(response.status).toBe(201);
  expect((await response.json() as { artifact: unknown }).artifact).toMatchObject({ series_key: '경쟁사 가격표', previous_id: third.id });
  const alien = await routine();
  await expect(alien.publish('다른 이름', '외부 수정', 'A,1', 'text/csv', first.id)).rejects.toThrow('publication_http_404');
  await expect(publish(null, '없는 파일', 'A,1', 'text/csv', crypto.randomUUID())).rejects.toThrow('publication_http_404');
  const standalone = await publish(null, null);
  const updatedStandalone = await publish('무시되는 표시명', '독립 파일 수정', 'A,2', 'text/csv', standalone.id);
  expect(updatedStandalone).toMatchObject({ series_key: null, previous_id: standalone.id });
});

test('brief requires visible assistant publication, ignores QA, and clips combined changes to 200 characters', async () => {
  const { context, publish, link } = await routine();
  await publish('연결 전', '보이면 안 됨');
  await link((await publish('숨김', '보이면 안 됨')).id, { hidden: true });
  await link((await publish('사용자 첨부', '보이면 안 됨')).id, { role: 'user' });
  const qaMessage = await link((await publish('QA 결과', '보이면 안 됨')).id, { qa: true, result: true });
  const first = await publish('정상', '가'.repeat(150));
  await link(first.id);
  const latest = await publish('정상', '나'.repeat(100));
  const message = await link(latest.id);
  // A later hidden or QA revision cannot erase previously published, legitimate changes.
  await link((await publish('정상', '숨긴 변경')).id, { hidden: true });
  await link((await publish('정상', '검증 변경')).id, { qa: true });
  const view = await briefView(sql, context.workspace, new Date().toISOString().slice(0, 10));
  const items = view.done.filter(item => item.id.startsWith('artifact:'));
  expect(items).toHaveLength(1);
  expect(view.done.some(item => item.id === `result:${qaMessage}`)).toBe(false);
  expect(items[0]).toMatchObject({ id: `artifact:${latest.id}`, message_id: message,
    title: `결과물 · 정상: ${('나'.repeat(100) + ' · ' + '가'.repeat(150)).slice(0, 200)}` });
});

test('brief preserves the latest series change when older summaries exhaust the character budget', async () => {
  const { context, publish, link } = await routine();
  await link((await publish('누적 변경', '가'.repeat(200))).id);
  await link((await publish('누적 변경', '나'.repeat(200))).id);
  const latest = await publish('누적 변경', '최신 가격 인하와 신규 경쟁사 추가');
  const message = await link(latest.id);
  const view = await briefView(sql, context.workspace, new Date().toISOString().slice(0, 10));
  expect(view.done.find(item => item.id === `artifact:${latest.id}`)).toMatchObject({ message_id: message,
    title: `결과물 · 누적 변경: ${('최신 가격 인하와 신규 경쟁사 추가 · ' + '나'.repeat(200) + ' · ' + '가'.repeat(200)).slice(0, 200)}` });
});

test('series tools enforce bounded optional parameters and exclude observation/send policies', async () => {
  const { publish } = await routine();
  await expect(publish('x'.repeat(61), '변경')).rejects.toThrow();
  await expect(publish('가격표', 'x'.repeat(201))).rejects.toThrow();
  if (publishArtifactTool.type !== 'function' || readArtifactTool.type !== 'function') throw new Error('Expected function tools');
  expect(publishArtifactTool.parameters?.['required']).toContain('series');
  expect(publishArtifactTool.parameters?.['required']).toContain('updates');
  expect(readArtifactTool.name).toBe('read_artifact');
  expect(offered('brief', 'read_artifact')).toBe(true);
  for (const policy of ['read_only', 'send_once'] as const) {
    expect(offered(policy, 'read_artifact')).toBe(false);
    expect(applyPolicy(policy, 'read_artifact', '{"series":"가격표"}')).toHaveProperty('refused');
  }
});
