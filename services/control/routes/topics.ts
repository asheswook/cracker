import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth';
import type { Database } from '../db';
import { DomainError } from '../../../packages/protocol';
import { conversationTopics, topicBranch } from '../../../packages/topics/store';
import { branchWork } from '../../../packages/topics/work';
import { attention } from '../../../packages/attention/store';
import { briefContext, withdrawBrief } from '../../../packages/attention/coordinator';
import { answerSourceItem, retrySource, updateObligation, itemThread, requestReply, taskSourceAccount, claimSend, claimSendCheck, confirmSend, noteAdapterCoverage, noteDraftRevision, noteThreadSnapshot, pinSendRevision, recheckSend, recordObservation, recordSendCheck, recordSendResult, sendJobKind, setWatch, WatchRequest } from '../../../packages/attention/sources';
import { authorizeReferenceRun } from '../repository/work-search';

/** Client read routes for topic chips and the branch sheet. Read-only over the knowledge tree. */
export function topicRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  const client = (principal: AppEnv['Variables']['principal']) => {
    if (principal.role !== 'client') throw new DomainError('forbidden', 'Client credentials required', 403);
    return principal.workspace_id;
  };
  app.get('/conversations/:id/topics', async c => {
    const workspace = client(c.get('principal')), id = z.uuid().parse(c.req.param('id'));
    const after = z.coerce.number().int().min(0).parse(c.req.query('after') ?? 0);
    c.header('Cache-Control', 'no-store');
    return c.json(await sql.begin('isolation level repeatable read read only', async tx => {
      if (!(await tx`SELECT 1 FROM assistant.conversations WHERE workspace_id=${workspace} AND id=${id}`)[0]) throw new DomainError('not_found', 'Conversation not found', 404);
      return conversationTopics(tx, workspace, id, after);
    }));
  });
  app.get('/topics/:id', async c => {
    const workspace = client(c.get('principal')), id = z.uuid().parse(c.req.param('id'));
    c.header('Cache-Control', 'no-store');
    const branch = await sql.begin('isolation level repeatable read read only', async tx => {
      const b = await topicBranch(tx, workspace, id);
      // The branch as work: what waits for the user, what runs, what came out, what was decided.
      return b ? { ...b, work: await branchWork(tx, workspace, b.messages.map(m => m.id)) } : null;
    });
    if (!branch) throw new DomainError('not_found', 'Topic not found', 404);
    return c.json(branch);
  });
  // Daemon: the same view for a run that writes a briefing (the VM credential must own the run).
  app.get('/context/:run/attention', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      const brief = await briefContext(tx, principal.workspace_id, task);
      if (brief) return { ...brief.view, since_last_brief: brief.since_last_brief };
      const full = await attention(tx, principal.workspace_id);
      // The run reading the view is not news to itself.
      return { ...full, in_progress: full.in_progress.filter(i => i.id !== `task:${task}`) };
    }));
  });
  app.post('/context/:run/brief', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body = z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(), source_quote: z.string().trim().min(2).max(300) }).parse(await c.req.json());
    const minute = body.time ? Number(body.time.slice(0, 2)) * 60 + Number(body.time.slice(3)) : null;
    return c.json(await sql.begin(async tx => {
      // Only the user changes the brief: the quote must come from a user message of this run's task.
      const source = (await tx`SELECT m.id FROM assistant.runs r JOIN assistant.messages m ON m.workspace_id=r.workspace_id AND m.task_id=r.task_id
        WHERE r.id=${run} AND m.role='user' AND m.origin='user' AND NOT m.synthetic AND position(${body.source_quote} in m.content)>0 ORDER BY m.sequence DESC LIMIT 1`)[0];
      if (!source) throw new DomainError('invalid_source', 'source_quote must be the user\'s own words from this conversation turn', 400);
      await tx`INSERT INTO assistant.attention_settings(workspace_id) VALUES(${principal.workspace_id}) ON CONFLICT DO NOTHING`;
      await tx`SELECT 1 FROM assistant.attention_settings WHERE workspace_id=${principal.workspace_id} FOR UPDATE`;
      await tx`UPDATE assistant.attention_settings SET brief_enabled=${body.enabled},brief_at_minute=${minute},source_message_id=${source['id']},updated_at=clock_timestamp() WHERE workspace_id=${principal.workspace_id}`;
      // Today's brief that has not been delivered follows the new settings: withdrawn (a running one cannot publish) and re-planned.
      await withdrawBrief(tx, principal.workspace_id);
      return { enabled: body.enabled, time: body.time ?? 'assistant chooses from the user\'s morning pattern', applies: 'from the next brief that has not gone out yet' };
    }));
  });
  // Daemon: the user changes a 피드 mail/Slack item by saying so (their quote must be in this turn's own messages).
  app.post('/context/:run/feed-item', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
    if (typeof raw['item_id'] === 'string') raw['item_id'] = raw['item_id'].replace(/^mail:/, '');
    // A refused change says why and that nothing changed, so the model can correct it and call again.
    const refuse = (reason: string) => c.json({ changed: false, refused: reason });
    const parsed = z.object({ item_id: z.uuid(), source_quote: z.string().trim().min(2).max(300), due_at: z.iso.datetime({ offset: true }).nullable(),
      blocked: z.string().trim().max(300).nullable(), clear_blocked: z.boolean(), done: z.boolean(), dismiss: z.boolean() }).safeParse(raw);
    if (!parsed.success) return refuse(`invalid arguments: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ').slice(0, 300)}`);
    const body = parsed.data;
    const result = await sql.begin(async tx => {
      const source = (await tx`SELECT m.id FROM assistant.runs r JOIN assistant.messages m ON m.workspace_id=r.workspace_id AND m.task_id=r.task_id
        WHERE r.id=${run} AND m.role='user' AND m.origin='user' AND NOT m.synthetic AND position(${body.source_quote} in m.content)>0 LIMIT 1`)[0];
      if (!source) return { changed: false, refused: 'source_quote is not the user\'s own words in this conversation turn' };
      const workspace = principal.workspace_id;
      if (body.done || body.dismiss) {
        if (!(await answerSourceItem(tx, workspace, body.item_id, body.dismiss ? 'dismiss' : 'handled'))) return { changed: false, refused: 'no open item with that id (it may be closed already)' };
        return { changed: true, closed: body.dismiss ? 'not_needed' : 'handled' };
      }
      const change: { due_at?: string | null; blocked?: string | null } = {};
      if (body.due_at) change.due_at = body.due_at;
      if (body.blocked) change.blocked = body.blocked; else if (body.clear_blocked) change.blocked = null;
      if (!Object.keys(change).length) return { changed: false, refused: 'nothing to change: set due_at, blocked, clear_blocked, done or dismiss' };
      if (!(await updateObligation(tx, workspace, body.item_id, change))) return { changed: false, refused: 'no open item with that id (it may be closed already)' };
      return { changed: true, fields: Object.keys(change) };
    });
    return c.json(result);
  });
  // Daemon: an observation run reports what it saw (structured, once).
  app.post('/context/:run/observation', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body: unknown = await c.req.json();
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      return recordObservation(tx, principal.workspace_id, task, body);
    }));
  });
  // Daemon (no model): a send job claims its approved envelope once, then reports what the fixed adapter observed.
  app.post('/context/:run/send/claim', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      return await sendJobKind(tx, principal.workspace_id, task) === 'check' ? { ...(await claimSendCheck(tx, principal.workspace_id, task)), check: true } : claimSend(tx, principal.workspace_id, task);
    }));
  });
  app.post('/context/:run/draft-revision', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body = z.object({ account: z.string().max(200).optional(), truncated: z.boolean().optional(), thread: z.string().max(40), revision: z.string().min(3).max(300).nullable(),
      messages: z.array(z.object({ from: z.string().max(300), from_address: z.string().max(300).nullable(), at: z.string().max(100), to: z.string().max(2000), body: z.string().max(60000) })).max(200).optional() }).parse(await c.req.json());
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      // Only a reading of the watched account counts (another account's thread with the same id is dropped).
      if (!(await taskSourceAccount(tx, principal.workspace_id, task, body.account ?? null))) return { noted: false, reason: 'account mismatch' };
      if (body.revision) await noteDraftRevision(tx, principal.workspace_id, task, body.thread, body.revision);
      if (body.messages) await noteThreadSnapshot(tx, principal.workspace_id, task, body.thread, body.messages, body.truncated === true);
      return { noted: true };
    }));
  });
  // Client: an unconfirmed send — check again (read only), or tell what happened in Gmail.
  app.post('/attention/send/:send/:how', async c => {
    const workspace = client(c.get('principal'));
    const send = z.uuid().parse(c.req.param('send')), how = z.enum(['recheck', 'sent', 'not_sent']).parse(c.req.param('how'));
    const ok = await sql.begin(tx => how === 'recheck' ? recheckSend(tx, workspace, send) : confirmSend(tx, workspace, send, how === 'sent'));
    // A stale screen (the operation already settled or replaced) gets 409, not a change to another operation.
    if (!ok) throw new DomainError('stale', 'This reply was already settled', 409);
    return c.json({ ok: true });
  });
  app.post('/context/:run/coverage', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body = z.object({ kind: z.enum(['gmail', 'slack_channels', 'slack_history']).default('gmail'), account: z.string().max(200).optional(), after: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/).optional(), before: z.string().nullable().optional(), channel: z.string().max(40).optional(), oldest: z.number().optional(), utc_offset_minutes: z.number().int().min(-900).max(900).optional(), team: z.string().max(40).optional(), cursor: z.string().max(400).optional(), next_cursor: z.string().max(400).optional(), channels: z.array(z.string().max(40)).max(5000).optional(), complete: z.boolean(), rows: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      await noteAdapterCoverage(tx, principal.workspace_id, task, body);
      return { noted: true };
    }));
  });
  app.post('/context/:run/send/revision', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body = z.object({ revision: z.string().min(3).max(300) }).parse(await c.req.json());
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      return pinSendRevision(tx, principal.workspace_id, task, body.revision);
    }));
  });
  app.post('/context/:run/send/result', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body: unknown = await c.req.json();
    return c.json(await sql.begin(async tx => {
      const task = String((await tx`SELECT task_id FROM assistant.runs WHERE id=${run}`)[0]?.['task_id']);
      if (await sendJobKind(tx, principal.workspace_id, task) === 'check') {
        const r = z.object({ found: z.boolean().nullable(), evidence: z.string().max(400) }).parse(body);
        return recordSendCheck(tx, principal.workspace_id, task, r.found, r.evidence);
      }
      return recordSendResult(tx, principal.workspace_id, task, body);
    }));
  });
  // Daemon: the user asks to watch (or stop watching) a source. Only from the user's own words in this turn.
  app.post('/context/:run/watch', async c => {
    const principal = c.get('principal');
    const run = z.uuid().parse(c.req.param('run'));
    await authorizeReferenceRun(sql, principal, run);
    const body = WatchRequest.parse(await c.req.json());
    return c.json(await sql.begin(async tx => {
      const source = (await tx`SELECT m.id,t.conversation_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id JOIN assistant.messages m ON m.workspace_id=r.workspace_id AND m.task_id=r.task_id
        WHERE r.id=${run} AND m.role='user' AND m.origin='user' AND NOT m.synthetic AND position(${body.source_quote} in m.content)>0 ORDER BY m.sequence DESC LIMIT 1`)[0];
      if (!source) throw new DomainError('invalid_source', 'source_quote must be the user\'s own words from this conversation turn', 400);
      const row = await setWatch(tx, { ...body, workspace: principal.workspace_id, conversation: String(source['conversation_id']), source_message: String(source['id']) });
      return body.mode === 'once' ? { looking_once: true, watch_enabled: row?.['enabled'] ?? false, note: 'results appear in the 피드 (feed); the standing watch was not changed' }
        : { watching: row?.['enabled'], account: body.account, every_minutes: row?.['interval_minutes'], next_check_at: row?.['next_check_at'] };
    }));
  });
  // Client: the thread of a feed item (messages as the adapter last read them, and its reply draft).
  app.get('/attention/mail/:id/thread', async c => {
    const workspace = client(c.get('principal'));
    const thread = await sql.begin('isolation level repeatable read read only', tx => itemThread(tx, workspace, z.uuid().parse(c.req.param('id'))));
    if (!thread) throw new DomainError('not_found', 'Item not found', 404);
    c.header('Cache-Control', 'no-store');
    return c.json(thread);
  });
  // Client: 답장 — ask for a reply draft on this thread, optionally with what it should say.
  app.post('/attention/mail/:id/reply', async c => {
    const workspace = client(c.get('principal'));
    const body = z.object({ note: z.string().trim().max(1000).nullable().default(null) }).strict().parse(await c.req.json().catch(() => ({})));
    const request = await sql.begin(tx => requestReply(tx, workspace, z.uuid().parse(c.req.param('id')), body.note || null));
    if (!request) throw new DomainError('stale', 'This thread is closed or a reply is already being sent', 409);
    return c.json({ ok: true, reply_request: { id: request, state: 'queued' } });
  });
  // Client: 필요 없음 (comes back only if the thread changes) or 내가 처리함 on a watched thread.
  // Client: 다시 확인 on a blocked watch (after logging in): one look now.
  app.post('/attention/source/:id/retry', async c => {
    const workspace = client(c.get('principal'));
    const r = await sql.begin(tx => retrySource(tx, workspace, z.uuid().parse(c.req.param('id'))));
    if (!r) throw new DomainError('not_found', 'Nothing to retry', 404);
    return c.json({ ok: true, looking: true });
  });
  // Client: move an obligation's due date, or say it is blocked (or not any more).
  app.post('/attention/mail/:id/obligation', async c => {
    const workspace = client(c.get('principal'));
    const body = z.object({ due_at: z.iso.datetime({ offset: true }).nullable().optional(), blocked: z.string().trim().max(300).nullable().optional() }).strict().parse(await c.req.json());
    const change: { due_at?: string | null; blocked?: string | null } = {};
    if (body.due_at !== undefined) change.due_at = body.due_at;
    if (body.blocked !== undefined) change.blocked = body.blocked || null;
    if (!(await sql.begin(tx => updateObligation(tx, workspace, z.uuid().parse(c.req.param('id')), change)))) throw new DomainError('not_found', 'Item not found', 404);
    return c.json({ ok: true });
  });
  app.post('/attention/mail/:id/:how', async c => {
    const workspace = client(c.get('principal'));
    const how = z.enum(['dismiss', 'handled']).parse(c.req.param('how'));
    if (!(await sql.begin(tx => answerSourceItem(tx, workspace, z.uuid().parse(c.req.param('id')), how)))) throw new DomainError('not_found', 'Item not found', 404);
    return c.json({ ok: true });
  });
  app.get('/attention', async c => {
    const workspace = client(c.get('principal'));
    c.header('Cache-Control', 'no-store');
    return c.json(await sql.begin('isolation level repeatable read read only', tx => attention(tx, workspace)));
  });
  return app;
}
