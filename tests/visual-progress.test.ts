import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response as ModelResponse, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { Assignment } from '../packages/protocol';
import type { Provider, ResponseInputItem } from '../packages/provider';
import { Runtime } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { ToolExecutor } from '../services/daemon/tools';
import { VisualProgress } from '../services/daemon/visual-progress';

async function frame(scene: number, variation: number): Promise<string> {
  const width = 1364, height = 1024, pixels = Buffer.alloc(width * height * 3, 245);
  const paint = (left: number, top: number, w: number, h: number, value: number) => {
    for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++)
      pixels.fill(value, (y * width + x) * 3, (y * width + x + 1) * 3);
  };
  paint(0, 0, width, 80, 60);
  paint(90 + scene * 110, 180, 200, 450, 40 + scene * 25);
  paint(1100, 20, 30, 12, 100 + variation);
  paint(600 + variation * 3, 800, 8, 8, 0);
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: variation % 2 ? 9 : 1 }).toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}
const request = (x: number, y = 287) => ({ name: 'computer_exec', arguments: JSON.stringify({ code: `await desktop.click(${x}, ${y});`, timeout_ms: 10000 }) });

test('same target with noisy but similar screenshots produces one bounded advisory', async () => {
  const progress = new VisualProgress(), notes = [];
  for (let n = 0; n < 13; n++) {
    const note = await progress.observe([await frame(0, n)], request(1260 + n % 12));
    if (note) notes.push(note);
  }
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: 'same-action-view', observations: 4 });
});

test('three-screen cycle survives cursor and clock changes', async () => {
  const progress = new VisualProgress(), notes = [];
  for (let n = 0; n < 15; n++) {
    const note = await progress.observe([await frame(n % 3, n)], request(200 + n % 3 * 200));
    if (note) notes.push(note);
  }
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: 'visual-cycle', period: 3, observations: 9 });
});

test('four-screen cycle is bounded to twelve final observations', async () => {
  const progress = new VisualProgress(), notes = [];
  for (let n = 0; n < 16; n++) {
    const note = await progress.observe([await frame(n % 4, n)], request(200 + n % 4 * 200));
    if (note) notes.push(note);
  }
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: 'visual-cycle', period: 4, observations: 12 });
});

test('separate fallback click and screenshot retain action correlation', async () => {
  const progress = new VisualProgress();
  for (let n = 0; n < 4; n++) {
    expect(await progress.observe([], { name: 'computer', arguments: JSON.stringify({ action: 'click', x: 1260 + n, y: 287 }) })).toBeUndefined();
    const note = await progress.observe([await frame(0, n)], { name: 'computer', arguments: '{"action":"screenshot"}' });
    if (n < 3) expect(note).toBeUndefined();
    else expect(note).toMatchObject({ kind: 'same-action-view', observations: 4 });
  }
});

test('opaque alpha and malformed captures do not corrupt the perceptual history', async () => {
  const progress = new VisualProgress();
  expect(await progress.observe(['data:image/png;base64,bm90IGEgcG5n'], request(1))).toBeUndefined();
  expect(await progress.observe(['data:image/jpeg;base64,ignored'])).toBeUndefined();
  for (let n = 0; n < 4; n++) {
    const original = await frame(0, n);
    const png = n % 2 ? await sharp(Buffer.from(original.slice(22), 'base64')).ensureAlpha().png().toBuffer() : Buffer.from(original.slice(22), 'base64');
    const note = await progress.observe(['data:image/png;base64,' + png.toString('base64')], request(1265));
    if (n < 3) expect(note).toBeUndefined();
    else expect(note).toMatchObject({ kind: 'same-action-view', observations: 4 });
  }
});

test('different content after the same click is not diagnosed as a repeated visual episode', async () => {
  const progress = new VisualProgress();
  for (let n = 0; n < 8; n++)
    expect(await progress.observe([await frame(n, n)], request(1265))).toBeUndefined();
});

test('typing requests with otherwise similar screenshots do not produce navigation guidance', async () => {
  const progress = new VisualProgress();
  for (let n = 0; n < 10; n++)
    expect(await progress.observe([await frame(0, n)], { name: 'computer_exec', arguments: JSON.stringify({ code: 'await desktop.type("private input");' }) })).toBeUndefined();
});

test('intermediate pictures do not replace final observation and reset starts a new episode', async () => {
  const progress = new VisualProgress();
  for (let n = 0; n < 8; n++)
    expect(await progress.observe([await frame(0, 0), await frame(n, n)], request(1265))).toBeUndefined();
  progress.reset();
  for (let n = 0; n < 3; n++) expect(await progress.observe([await frame(0, n)], request(1265))).toBeUndefined();
  expect(await progress.observe([])).toBeUndefined();
  expect(await progress.observe([await frame(0, 4)], request(1265))).toMatchObject({ kind: 'same-action-view' });
});

class CompletedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.done.resolve(); }
}
class NavigationFixture extends ToolExecutor {
  captures = 0;
  override async run(name: string) {
    if (name !== 'computer_exec') return { text: JSON.stringify({ verified_file: true }) };
    return { text: JSON.stringify({ captured: ++this.captures }), images: [await frame(0, this.captures)] };
  }
}
function response(output: ResponseOutputItem[]): ModelResponse {
  return { id: crypto.randomUUID(), object: 'response', created_at: 0, output, output_text: '', model: 'fixture', error: null, incomplete_details: null, instructions: null, metadata: null, parallel_tool_calls: false, temperature: null, top_p: null, tool_choice: 'auto', tools: [], status: 'completed' };
}
test('runtime delivers one advisory after interleaved tools while preserving observations and continuing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perceptual-runtime-'));
  const assignment: Assignment = {
    run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: 'Inspect a report.', state: 'running', reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    messages: [], instructions: 'Keep verified findings.', memory: [],
    model_binding: { revision_id: null, selection: { provider: 'chatgpt', model: 'gpt-6-astra', reasoning_effort: 'low' } },
  };
  let assigned = false;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/daemon/extensions') return Response.json({ skills: [], servers: [] });
    if (path === '/v1/daemon/poll') { const work = assigned ? null : assignment; assigned = true; return Response.json({ assignment: work, commands: [], messages: [] }); }
    return Response.json({ messages: [], accepted: true });
  } });
  const journal = new CompletedJournal(':memory:'), tools = new NavigationFixture(), history: ResponseInputItem[][] = [];
  const provider: Provider = { respond: async input => {
    history.push(structuredClone(input));
    const round = history.length;
    if (round <= 7) {
      const computer = round % 2 === 1;
      return response([{ type: 'function_call', call_id: `step-${round}`, name: computer ? 'computer_exec' : 'shell', arguments: computer ? request(1260 + round).arguments : '{"command":"pwd"}' }]);
    }
    return response([{ type: 'message', id: 'done', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixture finished.', annotations: [] }] }]);
  } };
  const runtime = new Runtime({ controlUrl: server.url.href, token: 'synthetic-fixture', journal, provider, tools, artifactRoot: directory });
  try {
    await runtime.tick(); await journal.done.promise; await runtime.flush();
    expect(history).toHaveLength(8);
    expect(tools.captures).toBe(4);
    const counts = history.map(input => input.filter(item => 'role' in item && item.role === 'system').length);
    expect(counts.slice(0, 7).every(count => count === counts[0])).toBe(true);
    expect(counts[7]).toBe((counts[0] ?? 0) + 1);
    const last = history.at(-1) ?? [];
    const results = last.filter(item => item.type === 'function_call_output');
    expect(results).toHaveLength(7);
    expect(results.filter(item => item.type === 'function_call_output' && item.output === '{"verified_file":true}')).toHaveLength(3);
    const images = last.flatMap(item => 'content' in item && Array.isArray(item.content) ? item.content.filter(part => part.type === 'input_image') : []);
    expect(images).toHaveLength(2);
  } finally {
    await runtime.stop(); journal.close(); await server.stop(true); await rm(directory, { recursive: true, force: true });
  }
});
