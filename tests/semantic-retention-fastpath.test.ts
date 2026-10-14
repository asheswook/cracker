import { expect, test } from 'bun:test';
import { SemanticModel } from '../services/daemon/semantic-context-model';
import type { Provider } from '../packages/provider';

const source = (content: string) => ({ id: crypto.randomUUID(), role: 'user' as const, content, created_at: new Date().toISOString(), sequence: 1 });
const failing: Provider = { respond: async () => { throw new Error('model must not be called'); } } as unknown as Provider;

test('ordinary turns are inherited without a model call', async () => {
  const context = { sources: [source('오늘 요일만 알려줘'), source('PG 분류 다시 정리해줘')], decisions: [] };
  const assessment = await new SemanticModel(failing).retention(context, AbortSignal.timeout(1000));
  expect(assessment.decisions.map(d => d.action)).toEqual(['inherit', 'inherit']);
});

test('turns that mention memory still go to the model', async () => {
  let called = 0;
  const provider = { respond: async () => { called++; throw new Error('stop'); } } as unknown as Provider;
  const context = { sources: [source('이건 기억하지 마')], decisions: [] };
  await expect(new SemanticModel(provider).retention(context, AbortSignal.timeout(1000)).then(() => 'ok', () => 'err')).resolves.toBe('err');
  expect(called).toBeGreaterThan(0);
});
