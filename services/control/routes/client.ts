import { answerCard, CardAnswerRequest, settleCardsForTask } from "../repository/card-answer";
import { settleBriefForTask } from "../../../packages/attention/coordinator";
import { redraftUnverified, settleObservationTask, settleSendTask } from "../../../packages/attention/sources";
import { Hono } from "hono";
import { z } from "zod";
import { Command, Conversation, DomainError, Id, ReadReceipt, Task } from "../../../packages/protocol";
import type { AppEnv } from "../auth";
import type { Database } from "../db";
import { appendMessage, messages, recordEvent } from "../repository/common";
import { assistantRoutes } from "./assistant";
import { personalRoutes } from "./personal";
import {composingState,replyHandoffState} from "../repository/composing";
import { backgroundState, workingState } from "../repository/working";
import { appearanceRoutes } from "./appearance";
import { TaskNavigation } from "../../../packages/protocol/task-navigation";
import { lockWorkspace } from '../repository/lock-order';
export function clientRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  app.get("/commands/:id", async (c) => {
    const id = Id.parse(c.req.param("id"));
    const rows =
      await sql`SELECT id,vm_id,task_id,kind,status,detail,created_at,acked_at FROM assistant.commands WHERE id=${id} AND workspace_id=${c.get("principal").workspace_id}`;
    if (!rows[0]) throw new DomainError("not_found", "Command not found", 404);
    const command = Command.extend({
      vm_id: Id,
      status: z.enum(["pending", "applied", "failed"]),
      detail: z.string().nullable(),
      acked_at: z.string().nullable(),
    }).parse(rows[0]);
    c.header("Cache-Control", "no-store");
    return c.json({ command });
  });
  app.route("/", assistantRoutes(sql));
  app.route("/", appearanceRoutes(sql));
  app.get("/conversations", async (c) =>
    c.json({
      conversations: z
        .array(Conversation.extend({ preview: z.string().nullable(), last_message_at: z.string().nullable(), message_count: z.coerce.number().int() }))
        .parse(
          await sql`SELECT c.*,
            (SELECT left(regexp_replace(m.content,'[[:space:]]+',' ','g'),120) FROM assistant.messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id AND m.role='user' AND btrim(m.content)<>'' ORDER BY m.sequence LIMIT 1) AS preview,
            (SELECT max(m.created_at) FROM assistant.messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id AND m.role IN ('user','assistant')) AS last_message_at,
            (SELECT count(*) FROM assistant.messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id AND m.role IN ('user','assistant')) AS message_count
            FROM assistant.conversations c WHERE c.workspace_id=${c.get("principal").workspace_id} ORDER BY c.created_at`,
        ),
    }),
  );
  app.post("/conversations", async (c) => {
    const body = z.object({ title: z.string().trim().min(1).max(200) }).parse(await c.req.json());
    const rows =
      await sql`INSERT INTO assistant.conversations(workspace_id,title) VALUES(${c.get("principal").workspace_id},${body.title}) RETURNING *`;
    return c.json({ conversation: Conversation.parse(rows[0]) }, 201);
  });
  app.get("/conversations/:id/messages", async (c) => {
    c.header("Cache-Control","no-store");
    const workspace = c.get("principal").workspace_id,
      id = Id.parse(c.req.param("id"));
    const receiptIds = z.array(Id).max(100).parse(c.req.query("receipt_ids")?.split(",") ?? []);
    const after = z.coerce.number().int().min(0).parse(c.req.query("after") ?? 0);
    const page = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const rows = await tx`SELECT id FROM assistant.conversations WHERE workspace_id=${workspace} AND id=${id}`;
      if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
      const result = await messages(tx, workspace, id, after);
      return {
        messages: result,
        composing: await composingState(tx, workspace, id),
        reply_handoff: await replyHandoffState(tx, workspace, id),
        working: await workingState(tx, workspace, id),
        background: await backgroundState(tx, workspace, id),
        cursor: result.at(-1)?.sequence ?? after,
        // Card state changes do not move the message cursor; send recent ones so every open device converges.
        card_states: after > 0 ? await tx`SELECT c.message_id,c.block_id,c.state,c.option,to_jsonb(c.snoozed_until)#>>'{}' AS snoozed_until FROM assistant.card_states c JOIN assistant.messages m ON m.workspace_id=c.workspace_id AND m.id=c.message_id
          WHERE c.workspace_id=${workspace} AND m.conversation_id=${id} AND c.updated_at>now()-interval '14 days' ORDER BY c.updated_at DESC LIMIT 200` : [],
        receipts: receiptIds.length ? z.array(ReadReceipt).parse(await tx`SELECT m.id AS message_id,min(i.applied_at) AS read_at FROM assistant.messages m JOIN assistant.input_receipts i ON i.message_id=m.id AND i.workspace_id=m.workspace_id WHERE m.workspace_id=${workspace} AND m.conversation_id=${id} AND m.role='user' AND m.id IN ${tx(receiptIds)} AND i.applied_at IS NOT NULL GROUP BY m.id`) : [],
      };
    });
    return c.json(page);
  });
  app.post("/conversations/:id/messages/:message/answer", async (c) => {
    const body = CardAnswerRequest.parse(await c.req.json());
    const workspace = c.get("principal").workspace_id;
    try {
      return c.json(await sql.begin((tx) => answerCard(tx, { workspace, conversation: Id.parse(c.req.param("id")), message: Id.parse(c.req.param("message")), ...body })));
    } catch (error) {
      // A draft that cannot be checked against its thread: the approval is refused, and a fresh draft is started for it.
      const { redraft, redraft_body } = (error ?? {}) as { redraft?: unknown; redraft_body?: unknown };
      if (typeof redraft === "string") await sql.begin(tx => redraftUnverified(tx, workspace, redraft, typeof redraft_body === "string" ? redraft_body : null));
      throw error;
    }
  });
  app.post("/conversations/:id/messages", async (c) => {
    const body = z
      .object({
        client_message_id: Id,
        reply_to_message_id: Id.optional(),
        content: z.string().max(100000),
        attachment_ids: z.array(Id).max(8).default([]),
      })
      .refine((value) => value.content.trim().length > 0 || value.attachment_ids.length > 0)
      .parse(await c.req.json());
    const input = {
      workspace: c.get("principal").workspace_id,
      conversation: Id.parse(c.req.param("id")),
      content: body.content,
      clientId: body.client_message_id,
      attachments: body.attachment_ids,
      ...(body.reply_to_message_id ? {replyTo:body.reply_to_message_id} : {}),
      returnControl: true as const,
    };
    return c.json(await sql.begin((tx) => appendMessage(tx, input)));
  });
  app.get("/tasks", async (c) =>
    c.json({
      tasks: z
        .array(Task)
        .parse(
          await sql`SELECT * FROM assistant.tasks WHERE workspace_id=${c.get("principal").workspace_id} ORDER BY created_at`,
        ),
    }),
  );
  app.get("/tasks/:id/navigation", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = Id.parse(c.req.param("id"));
    const rows = await sql`
      SELECT t.id AS task_id,t.conversation_id,
        (SELECT m.id FROM assistant.messages m WHERE m.workspace_id=t.workspace_id AND m.conversation_id=t.conversation_id AND m.task_id=t.id AND m.role IN ('user','system') ORDER BY m.sequence LIMIT 1) AS request_message_id,
        (SELECT m.id FROM assistant.messages m WHERE m.workspace_id=t.workspace_id AND m.conversation_id=t.conversation_id AND m.task_id=t.id AND m.role='assistant' ORDER BY m.sequence DESC LIMIT 1) AS reply_message_id,
        -- The original ask behind a scheduled or routine run (a reminder's or a routine's source message).
        (SELECT jsonb_build_object('conversation_id',u.conversation_id,'message_id',u.id) FROM assistant.messages u WHERE u.workspace_id=t.workspace_id AND u.id=coalesce(
          (SELECT s.source_message_id FROM assistant.messages w JOIN assistant.schedules s ON s.workspace_id=w.workspace_id AND s.id::text=w.client_message_id::text WHERE w.workspace_id=t.workspace_id AND w.task_id=t.id LIMIT 1),
          (SELECT r.source_message_id FROM assistant.responsibility_actions a JOIN assistant.responsibilities r ON r.id=a.responsibility_id WHERE a.task_id=t.id LIMIT 1))) AS source
      FROM assistant.tasks t WHERE t.workspace_id=${workspace} AND t.id=${id}`;
    if (!rows[0]) throw new DomainError("not_found", "Task not found", 404);
    c.header("Cache-Control", "no-store");
    return c.json(TaskNavigation.parse(rows[0]));
  });
  app.post("/tasks/:id/stop", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = Id.parse(c.req.param("id"));
    const command = await sql.begin(async (tx) => {
      await lockWorkspace(tx,workspace,'update');
      const assigned=await tx`SELECT id,vm_id FROM assistant.runs WHERE task_id=${id} AND workspace_id=${workspace} AND state NOT IN ('cancelled','succeeded','failed') ORDER BY (state='unknown'),created_at DESC,id DESC LIMIT 1`;
      if(assigned[0]){
        const run=z.object({id:Id,vm_id:Id}).parse(assigned[0]);
        await tx`SELECT id FROM assistant.vms WHERE id=${run.vm_id} AND workspace_id=${workspace} FOR UPDATE`;
        await tx`SELECT id FROM assistant.runs WHERE id=${run.id} FOR UPDATE`;
      }
      const rows =
        await tx`SELECT * FROM assistant.tasks WHERE workspace_id=${workspace} AND id=${id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Task not found", 404);
      const task = Task.parse(rows[0]);
      if (["succeeded", "failed", "cancelled"].includes(task.state))
        throw new DomainError("terminal_task", "Task already terminal", 409);
      const pending =
        await tx`SELECT * FROM assistant.commands WHERE task_id=${id} AND kind='stop' AND status='pending'`;
      if (pending[0]) return Command.parse(pending[0]);
      const runs =
        await tx`SELECT id,vm_id FROM assistant.runs WHERE task_id=${id} AND state NOT IN ('cancelled','succeeded','failed') ORDER BY (state='unknown'),created_at DESC,id DESC LIMIT 1`;
      if (!runs[0]) {
        if (task.state !== "queued")
          throw new DomainError("not_assigned", "Task has no VM to acknowledge stop", 409);
        await tx`UPDATE assistant.tasks SET state='cancelled',reason='Cancelled before VM assignment',updated_at=now() WHERE id=${id}`;
        await settleCardsForTask(tx, workspace, id, "cancelled");
        await settleBriefForTask(tx, workspace, id, "cancelled");
        await settleObservationTask(tx, workspace, id, "cancelled");
        await settleSendTask(tx, workspace, id, "cancelled");
        await recordEvent(tx, {
          workspace,
          kind: "task.cancelled_before_assignment",
          payload: JSON.stringify({ task_id: id }),
        });
        return null;
      }
      const run = z.object({ id: Id, vm_id: Id }).parse(runs[0]);
      const result =
        await tx`INSERT INTO assistant.commands(workspace_id,vm_id,task_id,run_id,kind) VALUES(${workspace},${run.vm_id},${id},${run.id},'stop') RETURNING *`;
      await tx`UPDATE assistant.tasks SET state='cancelling',updated_at=now() WHERE id=${id}`;
      return Command.parse(result[0]);
    });
    return c.json({ command });
  });
  app.get("/vms", async (c) =>
    c.json({
      vms: z
        .array(
          z.object({
            id: Id,
            name: z.string(),
            last_seen_at: z.string().nullable(),
            control_state: z.enum(["agent", "user", "switching", "unknown"]),
            online: z.boolean(),
          }),
        )
        .parse(
          await sql`SELECT *,COALESCE(last_seen_at>now()-interval '45 seconds',false) AS online FROM assistant.vms WHERE workspace_id=${c.get("principal").workspace_id} ORDER BY last_seen_at DESC NULLS LAST,id`,
        ),
    }),
  );
  app.post("/vms/:id/control", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = Id.parse(c.req.param("id"));
    const body = z
      .object({ kind: z.enum(["takeover", "return_control"]), client_command_id: Id.optional() })
      .parse(await c.req.json());
    const command = await sql.begin(async (tx) => {
      await lockWorkspace(tx,workspace);
      const vms =
        await tx`SELECT id FROM assistant.vms WHERE workspace_id=${workspace} AND id=${id} FOR UPDATE`;
      if (!vms[0]) throw new DomainError("not_found", "VM not found", 404);
      const replay = (row: unknown) => {
        const saved = Command.extend({ workspace_id: Id, vm_id: Id }).parse(row);
        if (saved.workspace_id !== workspace || saved.vm_id !== id || saved.kind !== body.kind)
          throw new DomainError(
            "idempotency_conflict",
            "Command ID already used for a different request",
            409,
          );
        return Command.parse(saved);
      };
      if (body.client_command_id) {
        const prior = await tx`SELECT * FROM assistant.commands WHERE id=${body.client_command_id}`;
        if (prior[0]) return replay(prior[0]);
      }
      const existing =
        await tx`SELECT * FROM assistant.commands WHERE vm_id=${id} AND status='pending' AND kind IN ('takeover','return_control')`;
      if (existing[0]) {
        const command = Command.parse(existing[0]);
        if (body.client_command_id || command.kind !== body.kind)
          throw new DomainError("switch_pending", "Control switch already pending", 409);
        return command;
      }
      const commandId = body.client_command_id ?? crypto.randomUUID();
      const result =
        await tx`INSERT INTO assistant.commands(id,workspace_id,vm_id,kind) VALUES(${commandId},${workspace},${id},${body.kind}) ON CONFLICT DO NOTHING RETURNING *`;
      if (!result[0]) {
        const prior = await tx`SELECT * FROM assistant.commands WHERE id=${commandId}`;
        return replay(prior[0]);
      }
      await tx`UPDATE assistant.vms SET control_state='switching' WHERE id=${id}`;
      return Command.parse(result[0]);
    });
    return c.json({ command });
  });
  app.route("/", personalRoutes(sql));
  return app;
}
