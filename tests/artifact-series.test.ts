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
  const publish = async (series: string | null, change_summary: string | null, content = 'company,price\nA,10000', media_type = 'text/csv') => {
    await Bun.write(join(artifacts.outputDirectory, 'prices.csv'), content);
    return artifacts.publish(JSON.stringify({ path: 'prices.csv', name: 'prices.csv', media_type, series, change_summary }), AbortSignal.timeout(5000));
  };
  return { context, artifacts, publish, run };
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
  expect(latest).toMatchObject({ artifact: { id: second.id }, content: 'A,7000', change_summary: 'A사 3,000원 인하' });
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

test('brief lists only the latest changed series once and excludes unchanged, blank and already briefed versions', async () => {
  const { context, publish } = await routine();
  const before = new Date(Date.now() - 60_000), now = new Date();
  const day = now.toISOString().slice(0, 10), yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const old = await publish('지난 결과', '지난 변경');
  await sql`UPDATE assistant.artifacts SET created_at=${new Date(before.getTime() - 60_000)} WHERE id=${old.id}`;
  await sql`INSERT INTO assistant.attention_briefs(workspace_id,local_date,state,planned_at,planned_minute,reason,settings_at,finished_at,snapshot_at)
    VALUES(${context.workspace},${yesterday}::date,'delivered',${before},540,'test',${before},${before},${before})`;
  await publish('경쟁사 가격표', '첫 버전');
  const latest = await publish('경쟁사 가격표', 'A사 3,000원 인하');
  await publish('변함없는 표', '이전 변경');
  await publish('변함없는 표', '변화 없음');
  await publish('빈 요약', '   ');
  const view = await briefView(sql, context.workspace, day, now);
  const items = view.done.filter(item => item.id.startsWith('artifact:'));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: `artifact:${latest.id}`, title: '결과물 · 경쟁사 가격표: A사 3,000원 인하' });
});

test('series tools enforce bounded optional parameters and exclude observation/send policies', async () => {
  const { publish } = await routine();
  await expect(publish('x'.repeat(61), '변경')).rejects.toThrow();
  await expect(publish('가격표', 'x'.repeat(201))).rejects.toThrow();
  if (publishArtifactTool.type !== 'function' || readArtifactTool.type !== 'function') throw new Error('Expected function tools');
  expect(publishArtifactTool.parameters?.['required']).toContain('series');
  expect(readArtifactTool.name).toBe('read_artifact');
  expect(offered('brief', 'read_artifact')).toBe(true);
  for (const policy of ['read_only', 'send_once'] as const) {
    expect(offered(policy, 'read_artifact')).toBe(false);
    expect(applyPolicy(policy, 'read_artifact', '{"series":"가격표"}')).toHaveProperty('refused');
  }
});
