import { HeaderBodySession } from '../../src/independent-header-protocol';
import { defaultAppearance } from '../../src/appearance/types';
import { ArchiveBanner } from '../../src/ArchiveBanner';
import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript';
import { FooterBodySession, FooterRenderSession, FooterProps, footerPacketFits, footerTaskSummary, benignFooterRejection } from '../../src/independent-footer-protocol';
import type { FooterPropsValue, FooterReply } from '../../src/independent-footer-protocol';
import { FooterContents } from '../../src/FooterContents';
const id = () => crypto.randomUUID();
function fixture(action: () => Promise<FooterReply> = async () => ({ ok: true })) {
  const props: FooterPropsValue = { scheme: 'light', readOnly: false, latest: true, error: '', storage: { failed: true, retrying: false }, task: null,
    drafts: [{ id: id(), name: 'test.txt', status: 'stored', progress: null, error: '', canRetry: true, canRemove: true }] };
  const session = new FooterBodySession(action);
  const state = session.update({ scope: 'workspace:conversation', visible: true, props });
  if (!state) throw new Error('missing state');
  const footerDocument = id();
  const event = { v: 1, kind: 'activate', document: session.document, footerDocument, generation: state.generation, scope: state.scope, revision: 1 };
  return { session, state, props, event, footerDocument };
}
test('duplicate async action executes once and preserves uncertain in-flight result', async () => {
  let finish: (value: FooterReply) => void = () => {}; let calls = 0;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  await f.session.handle(f.event);
  const command = { ...f.event, kind: 'action', revision: 2, commandId: id(), action: 'retry-upload', draftId: f.props.drafts[0]?.id };
  const first = f.session.handle(command), second = f.session.handle(command); await Promise.resolve();
  expect(calls).toBe(1); finish({ ok: false, error: 'action_failed' });
  expect(await first).toEqual(await second);
  expect(await f.session.handle({ ...command, revision: 3 })).toEqual({ ok: false, error: 'action_failed' }); expect(calls).toBe(1);
  expect((await f.session.handle({ ...command, revision: 4, action: 'remove-draft' })).error).toBe('command_mismatch');
});
test('older revision and changed same revision cannot activate after fallback', async () => {
  const f = fixture(); await f.session.handle(f.event);
  expect((await f.session.handle({ ...f.event, kind: 'fallback', revision: 3 })).ok).toBe(true);
  expect((await f.session.handle({ ...f.event, revision: 2 })).error).toBe('stale_revision');
  expect((await f.session.handle({ ...f.event, revision: 3 })).error).toBe('stale_revision');
  expect(f.session.footerDocument).toBeUndefined();
});
test('current scalar permissions reject read-only, missing draft, upload-in-flight and stale scope', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { ok: true }; }); await f.session.handle(f.event);
  expect((await f.session.handle({ ...f.event, kind: 'action', revision: 2, commandId: id(), action: 'remove-draft', draftId: id() })).error).toBe('action_unavailable');
  const uploading = f.session.update({ scope: f.state.scope, visible: true, props: { ...f.props, drafts: f.props.drafts.map(draft => ({ ...draft, status: 'uploading' as const, progress: 20, canRetry: false, canRemove: false })) } });
  expect((await f.session.handle({ ...f.event, generation: uploading?.generation, revision: 3 })).ok).toBe(true);
  expect((await f.session.handle({ ...f.event, generation: uploading?.generation, kind: 'action', revision: 4, commandId: id(), action: 'remove-draft', draftId: f.props.drafts[0]?.id })).error).toBe('action_unavailable');
  const next = f.session.update({ scope: 'next', visible: true, props: { ...f.props, readOnly: true } });
  expect((await f.session.handle({ ...f.event, revision: 3 })).error).toBe('stale_event');
  expect(next?.generation).toBe(3); expect(calls).toBe(0); expect(f.session.footerDocument).toBeUndefined();
  expect((await f.session.handle({ ...f.event, scope: 'next', generation: next?.generation, revision: 5 })).ok).toBe(true);
  expect((await f.session.handle({ ...f.event, scope: 'next', generation: next?.generation, kind: 'action', revision: 6, commandId: id(), action: 'retry-storage' })).error).toBe('action_unavailable');
});
test('throwing action is typed and deduplicated; busy and timeout rejection classes differ', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new Error('synthetic'); }); await f.session.handle(f.event);
  const command = { ...f.event, kind: 'action', revision: 2, commandId: id(), action: 'latest' };
  expect((await f.session.handle(command)).error).toBe('action_failed'); expect((await f.session.handle(command)).error).toBe('action_failed'); expect(calls).toBe(1);
  expect(benignFooterRejection('reader_busy')).toBe(true); expect(benignFooterRejection('footer_timeout')).toBe(false);
});
test('render identity and generation reject delayed or mutated data and retired main documents', () => {
  const f = fixture(); const receiver = new FooterRenderSession(f.footerDocument); const packet = { ...f.state, footerDocument: f.footerDocument };
  expect(receiver.receive(packet).ok).toBe(true); expect(receiver.receive(packet).ok).toBe(true);
  expect(receiver.receive({ ...packet, visible: false }).ok).toBe(false);
  expect(receiver.receive({ ...packet, document: id(), generation: 1 }).ok).toBe(true); expect(receiver.receive(packet).ok).toBe(false);
});
test('legacy task payload cannot duplicate the feed diagnostic in the native footer or hide other controls', () => {
  const reason = 'r'.repeat(120000); const task = { id: id(), state: 'failed', reason }; const preview = footerTaskSummary(task);
  expect(preview?.reason?.length).toBe(2000); expect(preview?.reasonTruncated).toBe(true); expect(task.reason.length).toBe(120000);
  const f = fixture(); const markup = renderToStaticMarkup(FooterContents({ value: { ...f.props, task: preview }, action: () => {} }));
  expect(markup).not.toContain('일부 내용 · 전체 이유 보기'); expect(markup).not.toContain('system-event');
  expect(markup).not.toContain(preview?.reason ?? 'unexpected missing preview'); expect(markup).toContain('test.txt'); expect(markup).toContain('최신 메시지');
});
test('strict scalar and UTF8 envelope bounds reject oversize rather than clipping names/errors', () => {
  const f = fixture(); expect(FooterProps.safeParse({ ...f.props, error: 'x'.repeat(8193) }).success).toBe(false);
  const drafts = Array.from({ length: 8 }, () => ({ ...f.props.drafts[0], id: id(), name: '한'.repeat(4096), error: '한'.repeat(8192) }));
  const props = FooterProps.parse({ ...f.props, drafts }); expect(footerPacketFits({ ...f.state, props })).toBe(false);
});
test('footer-only static runtime graph excludes App/store/API/reader/composer initialization', () => {
  const sourceRoot = resolve(import.meta.dir, '../../src'); const seen = new Set<string>();
  function visit(path: string) {
    if (seen.has(path)) return; seen.add(path);
    const text = readFileSync(path, 'utf8'); const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.') || specifier.endsWith('.css')) continue;
      const target = ['.tsx', '.ts'].map(extension => resolve(dirname(path), specifier + extension)).find(existsSync);
      if (target) visit(target);
    }
  }
  visit(resolve(sourceRoot, 'FooterOnly.tsx'));
  for (const name of ['App.tsx', 'store.ts', 'api.ts', 'attachmentDrafts.ts', 'useNativeRootReader.ts', 'native-composer-hook.ts', 'feed-causal-trace.ts']) expect(seen.has(resolve(sourceRoot, name))).toBe(false);
  const main = readFileSync(resolve(sourceRoot, 'main.tsx'), 'utf8'); expect(main.indexOf("__ASSISTANT_HYBRID_ROLE__ === 'footer'")).toBeLessThan(main.indexOf("await import('./body-entry')"));
});

test('actual archive return action is scoped, deduplicated and unavailable outside archive', () => {
  let returned = 0; const session = new HeaderBodySession(action => { if (action === 'archive-return') returned++; return true; });
  const state = session.update({ scope: 'archive', visible: true, props: { name: 'A', archiveTitle: '', connected: true, computerOpen: false,
    working: false, appearance: defaultAppearance, scheme: 'light', time: { available: false, pinned: false } } });
  if (!state) throw new Error('missing header state');
  const event = { v: 1, document: session.document, headerDocument: id(), scope: state.scope, generation: state.generation };
  expect(session.handle({ ...event, kind: 'activate' }).ok).toBe(true);
  const command = { ...event, kind: 'action', commandId: id(), action: 'archive-return' };
  expect(session.handle(command).ok).toBe(true); expect(session.handle(command).ok).toBe(true); expect(returned).toBe(1);
  session.update({ scope: 'assistant', visible: true, props: { ...state.props, archiveTitle: null } });
  expect(session.handle(command).error).toBe('stale_event');
  expect(renderToStaticMarkup(ArchiveBanner({ onReturn: () => {} }))).toContain('메시지로 돌아가기');
});

test('queued footer action cannot resolve a newer Chat binding after synchronous scope change', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { ok: true }; }); await f.session.handle(f.event);
  const pending = f.session.handle({ ...f.event, kind: 'action', revision: 2, action: 'retry-storage', commandId: id() });
  f.session.update({ scope: 'different-conversation', visible: true, props: f.props });
  expect((await pending).error).toBe('stale_event'); expect(calls).toBe(0);
});
test('archive placeholder keeps identical flow root class but removes accessibility and hit targets', () => {
  const markup = renderToStaticMarkup(ArchiveBanner({ onReturn: () => {}, placeholder: true }));
  expect(markup).toContain('class="archive-banner"'); expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('visibility:hidden'); expect(markup).toContain('inert=""'); expect(markup).toContain('disabled=""');
});
