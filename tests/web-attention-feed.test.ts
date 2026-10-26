import { afterEach, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { http } from '../apps/web/src/api';
import { Attention, automated, Item, refreshAttention, resetAttentionFeed, useAttention } from '../apps/web/src/attention-feed';
import { AttentionPanel, briefLabel } from '../apps/web/src/AttentionPanel';
import { replyStatus, Thread } from '../apps/web/src/FeedThread';

const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const item = (who: string, id = 'mail:one') => Item.parse({
  id, kind: 'mail', title: 'Review requested', detail: null, at: new Date().toISOString(),
  conversation_id: crypto.randomUUID(), message_id: null, state: 'request', who,
});
const feed = (needs_you: Item[] = [], done: Item[] = []) => Attention.parse({ needs_you, in_progress: [], done });
const snapshot = () => {
  let value: ReturnType<typeof useAttention> | undefined;
  function Probe() { value = useAttention(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return value!;
};
let get: ReturnType<typeof spyOn> | undefined;
afterEach(() => { get?.mockRestore(); get = undefined; resetAttentionFeed(); });

test('reset clears login data, ignores stale success/failure, and preserves the current in-flight request', async () => {
  const requests: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  get = spyOn(http, 'get').mockImplementation(() => ({
    json: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  }) as ReturnType<typeof http.get>);
  const old = refreshAttention();
  resetAttentionFeed();
  const fresh = refreshAttention();
  requests[0]!.resolve(feed([item('Old user')]));
  await old;
  expect(snapshot()).toEqual({ data: null, error: '' });
  expect(refreshAttention()).toBe(fresh);
  requests[1]!.resolve(feed([item('New user')]));
  await fresh;
  expect(snapshot().data?.needs_you[0]?.who).toBe('New user');

  const staleFailure = refreshAttention();
  resetAttentionFeed();
  const failing = refreshAttention();
  requests[2]!.reject(new Error('old login failed'));
  await staleFailure;
  expect(snapshot()).toEqual({ data: null, error: '' });
  requests[3]!.reject(new Error('current login failed'));
  await failing;
  expect(snapshot().data).toBeNull();
  expect(snapshot().error).not.toBe('');
});

test('a failed refresh retains only the current login data', async () => {
  get = spyOn(http, 'get').mockImplementationOnce(() => ({ json: async () => feed([item('Current user')]) }) as ReturnType<typeof http.get>)
    .mockImplementationOnce(() => ({ json: async () => { throw new Error('offline'); } }) as ReturnType<typeof http.get>);
  await refreshAttention();
  await refreshAttention();
  expect(snapshot().data?.needs_you[0]?.who).toBe('Current user');
  expect(snapshot().error).not.toBe('');
  resetAttentionFeed();
  expect(snapshot()).toEqual({ data: null, error: '' });
});

test('automated actionable mail stays in 지금 할 일; only non-actionable mail is folded', async () => {
  expect(automated(item('Talbot'))).toBe(false);
  expect(automated(item('Build Bot'))).toBe(true);
  get = spyOn(http, 'get').mockImplementation(() => ({ json: async () => feed(
    [item('Build Bot'), item('Talbot', 'mail:two')], [item('Alert Bot', 'mail:three')],
  ) }) as ReturnType<typeof http.get>);
  await refreshAttention();
  const html = renderToStaticMarkup(createElement(AttentionPanel, { onOpen: () => {} }));
  expect(html).toContain('지금 할 일 <span class="feed-count">2</span>');
  expect(html.indexOf('Build Bot')).toBeLessThan(html.indexOf('자동 알림'));
  expect(html).toContain('자동 알림 1개');
  expect(html).toContain('자동 ·');
});

test('brief labels distinguish today from a recent delivery on the previous local day', () => {
  const now = new Date(2026, 9, 25, 1, 0);
  expect(briefLabel(new Date(2026, 9, 25, 0, 30).toISOString(), now)).toBe('오늘 아침 브리핑 · 30분 전');
  expect(briefLabel(new Date(2026, 9, 24, 23, 30).toISOString(), now)).toMatch(/^최근 브리핑 · 어제 /);
});

test('reply requests parse older responses and poll queued/preparing requests without a draft', () => {
  const base = { id: 'mail', open: true, messages: [], draft: null };
  expect(replyStatus(Thread.parse(base))).toMatchObject({ preparing: false, waiting: false, failed: false });
  expect(Thread.parse({ ...base, reply_request: null }).reply_request).toBeNull();
  for (const state of ['queued', 'preparing'] as const) {
    const parsed = Thread.parse({ ...base, reply_request: { id: 'request', state, note: 'Say yes', at: new Date().toISOString() } });
    expect(replyStatus(parsed)).toMatchObject({ preparing: true, waiting: true, note: 'Say yes', failed: false });
  }
  const failed = Thread.parse({ ...base, draft: { preparing: true }, reply_request: { id: 'request', state: 'failed', note: 'Try again', at: new Date().toISOString() } });
  expect(replyStatus(failed)).toMatchObject({ preparing: false, waiting: false, failed: true, note: 'Try again' });
  expect(replyStatus(Thread.parse(base), '')).toMatchObject({ preparing: true, waiting: true });
  expect(replyStatus(Thread.parse(base))).toMatchObject({ preparing: false, waiting: false });
  expect(replyStatus(Thread.parse({ ...base, draft: { preparing: true } }))).toMatchObject({ preparing: true, waiting: true });
});
