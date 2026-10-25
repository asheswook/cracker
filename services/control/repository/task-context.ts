import { sourceRunPolicy } from "../../../packages/attention/sources";
import { retentionContext } from "../../../packages/memory/retention-store";
import { taskSkill } from "../../../packages/extensions/versions.ts";
import { runModelBinding } from "../../../packages/models/repository.ts";
import { z } from "zod";
import {
  Assignment,
  RecoveryContext,
  DomainError,
  Message,
  Persona,
  PriorWorkPage,
  type PriorWorkRequest,
  Task,
  TaskSourcePage,
  WorkCapsule,
} from "../../../packages/protocol";
import { retrieveMemory } from "../../../packages/memory/persist";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { fenceSession } from './daemon-session';
import { readWorkMailbox } from './mailbox-read';
async function ownedTask(sql: Query, principal: Principal, run: string) {
  await fenceSession(sql,principal,principal.daemon_session_id,false);
  const rows =
    await sql`SELECT t.* FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${run} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id}
      AND r.daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid`;
  if (!rows[0]) throw new DomainError("not_found", "Run not found", 404);
  return Task.parse(rows[0]);
}
async function taskMessages(
  sql: Query,
  workspace: string,
  task: string,
  after = 0,
  limit: number | null = null,
) {
  return z
    .array(Message)
    .parse(
      await sql`SELECT m.*,COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=m.id),'[]'::jsonb) AS attachments FROM assistant.messages m WHERE m.workspace_id=${workspace} AND m.task_id=${task} AND m.sequence>${after} ORDER BY m.sequence LIMIT ${limit}`,
    );
}
async function capsules(
  sql: Query,
  principal: Principal,
  current: z.infer<typeof Task>,
  before: string | null,
) {
  if (before) {
    const found =
      await sql`SELECT id FROM assistant.tasks WHERE id=${before} AND workspace_id=${principal.workspace_id} AND conversation_id=${current.conversation_id} AND id<>${current.id}`;
    if (!found[0]) throw new DomainError("not_found", "Prior work cursor not found", 404);
  }
  const tasks = z
    .array(Task)
    .parse(
      await sql`SELECT * FROM assistant.tasks t WHERE t.workspace_id=${principal.workspace_id} AND t.conversation_id=${current.conversation_id} AND t.id<>${current.id} AND (${current.lane!=='background'} OR t.state IN ('cancelled','succeeded','failed','unknown')) AND (t.created_at,t.id)<(${current.created_at}::timestamptz,${current.id}::uuid) AND (${before}::uuid IS NULL OR (t.created_at,t.id)<(SELECT created_at,id FROM assistant.tasks WHERE id=${before})) ORDER BY t.created_at DESC,t.id DESC LIMIT 9`,
    );
  const page = tasks.slice(0, 8);
  const records = await Promise.all(
    page.map(async (task) => {
      const sources = z
        .array(Message)
        .parse(
          await sql`SELECT m.*,COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=m.id),'[]'::jsonb) AS attachments FROM assistant.messages m WHERE m.workspace_id=${principal.workspace_id} AND m.task_id=${task.id} AND (m.id=(SELECT id FROM assistant.messages WHERE task_id=${task.id} AND role IN ('user','system') ORDER BY sequence LIMIT 1) OR m.id IN (SELECT id FROM assistant.messages WHERE task_id=${task.id} AND role IN ('user','system') ORDER BY sequence DESC LIMIT 2) OR m.id=(SELECT id FROM assistant.messages WHERE task_id=${task.id} AND role='assistant' ORDER BY sequence DESC LIMIT 1)) ORDER BY m.sequence`,
        );
      return WorkCapsule.parse({
        task_id: task.id,
        state: task.state,
        objective_excerpt: task.objective.slice(0, 1200),
        objective_truncated: task.objective.length > 1200,
        sources: sources.map((source) => ({
          source_message_id: source.id,
          role: source.role,
          excerpt: source.content.slice(0, 1200),
          truncated: source.content.length > 1200,
          attachment_ids: (source.attachments ?? []).map((a) => a.id),
        })),
      });
    }),
  );
  return {
    records,
    hasMore: tasks.length > 8,
    next: tasks.length > 8 ? (page.at(-1)?.id ?? null) : null,
  };
}
export async function workContext(sql: Query, principal: Principal, run: string) {
  const task = await ownedTask(sql, principal, run);
  const recovery=z.object({recovery:RecoveryContext.nullable()}).parse((await sql`SELECT recovery FROM assistant.runs WHERE id=${run} AND workspace_id=${principal.workspace_id}`)[0]).recovery;
  const workspace = z
    .object({ instructions: z.string(), persona: Persona })
    .parse(
      (
        await sql`SELECT instructions,json_build_object('name',persona_name,'role',persona_role,'style',persona_style) AS persona FROM assistant.workspaces WHERE id=${principal.workspace_id}`
      )[0],
    );
  const prior = await capsules(sql, principal, task, null);
  return Assignment.parse({
    ...(recovery?{recovery}:{}),
    model_binding: await runModelBinding(sql, principal, run),
    skill_binding: await taskSkill(sql,principal.workspace_id,task.id),
    // Source jobs run under a policy the daemon enforces (looks/drafts read only, a send job sends one reply).
    ...await (async () => { const policy = await sourceRunPolicy(sql, principal.workspace_id, task.id); return policy ? { run_policy: policy } : {}; })(),
    task,
    lane: task.lane ?? 'foreground',
    run_id: run,
    messages: await taskMessages(sql, principal.workspace_id, task.id),
    ...workspace,
    memory: await retrieveMemory(sql, principal.workspace_id, task.conversation_id),
    work_context: {
      prior_work: prior.records,
      has_older_work: prior.hasMore,
      next_before_task_id: prior.next,
    },
  });
}
export async function priorWork(
  sql: Query,
  principal: Principal,
  run: string,
  request: z.infer<typeof PriorWorkRequest>,
) {
  const current = await ownedTask(sql, principal, run);
  if (!request.task_id) {
    const page = await capsules(sql, principal, current, request.before_task_id);
    return PriorWorkPage.parse({
      capsules: page.records,
      messages: [],
      has_more: page.hasMore,
      next_before_task_id: page.next,
      next_after_sequence: null,
    });
  }
  const found =
    await sql`SELECT id FROM assistant.tasks WHERE id=${request.task_id} AND id<>${current.id} AND workspace_id=${principal.workspace_id} AND conversation_id=${current.conversation_id} AND (created_at,id)<(${current.created_at}::timestamptz,${current.id}::uuid)`;
  if (!found[0]) throw new DomainError("not_found", "Prior task not found", 404);
  const all = await taskMessages(
      sql,
      principal.workspace_id,
      request.task_id,
      request.after_sequence,
      101,
    ),
    page = all.slice(0, 100);
  return PriorWorkPage.parse({
    capsules: [],
    messages: page,
    has_more: all.length > 100,
    next_before_task_id: null,
    next_after_sequence: all.length > 100 ? (page.at(-1)?.sequence ?? null) : null,
  });
}
export async function taskSources(sql: Query, principal: Principal, run: string, after: number) {
  const task = await ownedTask(sql, principal, run),
    all = await taskMessages(sql, principal.workspace_id, task.id, after, 101),
    page = all.slice(0, 100);
  return TaskSourcePage.parse({
    retention_context: await retentionContext(sql, { workspace: principal.workspace_id, task: task.id }),
    messages: page,
    memory: await retrieveMemory(sql, principal.workspace_id, task.conversation_id),
    next_after_sequence: all.length > 100 ? (page.at(-1)?.sequence ?? null) : null,
  });
}
export async function workMailbox(sql: Query, principal: Principal, run: string, after: number) {
  return readWorkMailbox(sql,principal,run,after);
}
