import { enqueueMessageNotification } from "../../../packages/notifications/store.ts";
import { publishAttentionMessage } from "../../../packages/notifications/attention.ts";
import { z } from "zod";
import { attachmentReferences, bindAttachments } from "../../../packages/artifacts/references";
import { Command, type DaemonEvent, DomainError } from "../../../packages/protocol";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { recordEvent } from "./common";
import { loadRun } from "./runs";
import {clearComposing,clearDeliveredComposing} from "./composing";
import { linkAssistantContext } from "../../../packages/context/store";
import { validateResponseAttribution } from "../../../packages/context/structure-store";

const terminal = ["cancelled", "succeeded", "failed"];
function unreachable(value: never): never {
  throw new DomainError("invalid_event", `Unsupported event ${String(value)}`);
}
export async function applyEvent(sql: Query, principal: Principal, event: DaemonEvent) {
  // Event and semantic receipts reference the workspace; memory extraction locks it before conversations.
  await sql`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR KEY SHARE`;
  await sql`SELECT id FROM assistant.vms WHERE id=${principal.vm_id} FOR UPDATE`;
  const previous =
    await sql`SELECT workspace_id,vm_id,payload FROM assistant.events WHERE event_id=${event.event_id}`;
  if (previous[0]) {
    const stored = z
      .object({ workspace_id: z.uuid(), vm_id: z.uuid(), payload: z.unknown() })
      .parse(previous[0]);
    if (
      stored.workspace_id !== principal.workspace_id ||
      stored.vm_id !== principal.vm_id ||
      JSON.stringify(sortObject(stored.payload)) !== JSON.stringify(sortObject(event))
    )
      throw new DomainError("idempotency_conflict", "Event ID reused", 409);
    return;
  }
  switch (event.kind) {
    case "skill_loaded": {
      const run=await loadRun(sql,principal,event.run_id);
      if(!['running','waiting'].includes(run.state))throw new DomainError('stale_run','Run cannot load skill',409);
      const rows=await sql`UPDATE assistant.skill_executions e SET loaded_at=COALESCE(e.loaded_at,now()),loaded_run_id=${run.id} FROM assistant.skill_versions v WHERE e.task_id=${run.task_id} AND e.workspace_id=${principal.workspace_id} AND e.vm_id=${principal.vm_id} AND e.skill_id=${event.skill_id} AND e.revision=${event.revision} AND v.workspace_id=e.workspace_id AND v.skill_id=e.skill_id AND v.revision=e.revision AND v.content_hash=${event.content_hash} RETURNING e.id`;
      if(!rows.length)throw new DomainError('skill_binding_mismatch','Skill load receipt mismatch',409);
      break;
    }
    case "heartbeat":
      if (event.run_id) await loadRun(sql, principal, event.run_id);
      await sql`UPDATE assistant.vms SET last_seen_at=now() WHERE id=${principal.vm_id}`;
      break;
    case "message": {
      const run = await loadRun(sql, principal, event.run_id);
      if (terminal.includes(run.state) || run.state === "unknown")
        throw new DomainError("stale_run", "Run cannot emit messages", 409);
      await clearDeliveredComposing(sql,run.id,event.event_id);
      const task = z
        .object({ conversation_id: z.uuid(), origin: z.enum(["user", "schedule", "responsibility"]) })
        .parse((await sql`SELECT conversation_id,origin FROM assistant.tasks WHERE id=${run.task_id}`)[0]);
      const attachments = await attachmentReferences(
        sql,
        { workspace: principal.workspace_id, conversation: task.conversation_id },
        event.attachment_ids ?? [],
      );
      // Attribution is independent of semantic feature flags and never creates exchanges.
      await validateResponseAttribution(sql,{workspace:principal.workspace_id,conversation:task.conversation_id,task_id:run.task_id},event.response_to_message_id??null,event.applied_user_ids??[]);
      const inserted = z
        .object({ id: z.uuid() })
        .parse(
          (
            await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content,phase,response_to_message_id,applied_user_ids,output_kind,origin) VALUES(COALESCE(${event.message_id ?? null}::uuid,gen_random_uuid()),${principal.workspace_id},${task.conversation_id},${run.task_id},'assistant',${event.content},${event.phase ?? null},${event.response_to_message_id??null},${sql.array(event.applied_user_ids??[])}::uuid[],${event.output_kind??null},${task.origin}) RETURNING id`
          )[0],
        );
      if(event.response_to_message_id||event.applied_user_ids?.length) {
        const message=z.object({sequence:z.coerce.number()}).parse((await sql`SELECT sequence FROM assistant.messages WHERE workspace_id=${principal.workspace_id} AND id=${inserted.id}`)[0]);
        await validateResponseAttribution(sql,{workspace:principal.workspace_id,conversation:task.conversation_id,task_id:run.task_id},event.response_to_message_id??null,event.applied_user_ids??[],message.sequence);
      }
      await bindAttachments(
        sql,
        {
          workspace: principal.workspace_id,
          conversation: task.conversation_id,
          message: inserted.id,
        },
        attachments.map((file) => file.id),
      );
      if (event.semantic_context_id) await linkAssistantContext(sql, {
        workspace: principal.workspace_id, conversation: task.conversation_id,
        run_id: run.id, context_id: event.semantic_context_id, message_id: inserted.id,
        ...(event.semantic_source_message_id ? { source_message_id: event.semantic_source_message_id } : {}),
      });
      await enqueueMessageNotification(sql, principal.workspace_id, { id: inserted.id, runId: run.id });
      break;
    }
    case "state": {
      const run = await loadRun(sql, principal, event.run_id);
      await clearComposing(sql,run.id);
      if (run.state === "unknown" && event.state === "unknown") break;
      const link = z
        .object({ conversation_id: z.uuid() })
        .parse((await sql`SELECT conversation_id FROM assistant.tasks WHERE id=${run.task_id}`)[0]);
      await sql`SELECT id FROM assistant.conversations WHERE id=${link.conversation_id} FOR UPDATE`;
      const task = z
        .object({ state: z.string() })
        .parse(
          (await sql`SELECT state FROM assistant.tasks WHERE id=${run.task_id} FOR UPDATE`)[0],
        );
      if (event.state === "succeeded") {
        const pending =
          await sql`SELECT m.id FROM assistant.messages m WHERE m.task_id=${run.task_id} AND m.role IN ('user','system') AND NOT EXISTS(SELECT 1 FROM assistant.input_receipts i WHERE i.run_id=${run.id} AND i.message_id=m.id) LIMIT 1`;
        if (pending[0])
          throw new DomainError(
            "pending_input",
            "New task input must be applied before completion",
            409,
          );
      }
      if (terminal.includes(run.state) || run.state === "unknown")
        throw new DomainError("stale_run", "Run is terminal or requires reconciliation", 409);
      if (
        event.state === "queued" ||
        event.state === "cancelled" ||
        event.state === "pausing" ||
        event.state === "cancelling"
      )
        throw new DomainError(
          "invalid_transition",
          "State requires control-plane transition or command ACK",
          409,
        );
      if (task.state === "cancelling" && event.state !== "unknown")
        throw new DomainError("stop_pending", "Stop acknowledgement required", 409);
      await sql`UPDATE assistant.runs SET state=${event.state},updated_at=now() WHERE id=${run.id}`;
      await sql`UPDATE assistant.tasks SET state=${event.state},reason=${event.reason},updated_at=now() WHERE id=${run.task_id}`;
      if (event.state === "failed" || event.state === "unknown")
        await publishAttentionMessage(sql, principal.workspace_id, { id: run.id, state: event.state });
      break;
    }
    case "command_ack": {
      const rows =
        await sql`SELECT * FROM assistant.commands WHERE id=${event.command_id} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Command not found", 404);
      const command = Command.extend({ status: z.string(), run_id: z.uuid().nullable() }).parse(
        rows[0],
      );
      if (command.status !== "pending")
        throw new DomainError("stale_ack", "Command already acknowledged", 409);
      if (command.run_id) {
        const run = await loadRun(sql, principal, command.run_id);
        if (!(event.status === "applied" && event.execution_continues === true && command.kind !== "stop"))
          await clearComposing(sql,run.id);
        if (terminal.includes(run.state) && command.kind !== "return_control")
          throw new DomainError("stale_ack", "Command run already terminal", 409);
      }
      switch (command.kind) {
        case "stop":
          await sql`UPDATE assistant.tasks SET state=${event.status === "applied" ? "cancelled" : "unknown"},reason=${event.detail},updated_at=now() WHERE id=${command.task_id}`;
          await sql`UPDATE assistant.runs SET state=${event.status === "applied" ? "cancelled" : "unknown"},updated_at=now() WHERE id=${command.run_id}`;
          if (event.status === "failed" && command.run_id)
            await publishAttentionMessage(sql, principal.workspace_id, { id: command.run_id, state: "unknown" });
          break;
        case "takeover":
          await sql`UPDATE assistant.vms SET control_state=${event.status === "applied" ? "user" : "unknown"} WHERE id=${principal.vm_id}`;
          if (event.status === "applied" && event.execution_continues !== true) {
            if (event.resume_safe === true) {
              await sql`UPDATE assistant.tasks SET state='paused',updated_at=now() WHERE id IN (SELECT task_id FROM assistant.runs WHERE vm_id=${principal.vm_id} AND state IN ('running','waiting','pausing','paused')) AND state IN ('running','waiting','pausing','paused')`;
              await sql`UPDATE assistant.runs SET state='paused',updated_at=now() WHERE vm_id=${principal.vm_id} AND state IN ('running','waiting','pausing','paused')`;
            } else {
              await sql`UPDATE assistant.tasks SET state='unknown',reason='Takeover interrupted actions without safe-resume proof; reconcile local journal',updated_at=now() WHERE id IN (SELECT task_id FROM assistant.runs WHERE vm_id=${principal.vm_id} AND state IN ('running','waiting','pausing','paused')) AND state IN ('running','waiting','pausing','paused')`;
              const interrupted = z.array(z.object({ id: z.uuid() })).parse(
                await sql`UPDATE assistant.runs SET state='unknown',updated_at=now() WHERE vm_id=${principal.vm_id} AND state IN ('running','waiting','pausing','paused') RETURNING id`,
              );
              for (const run of interrupted)
                await publishAttentionMessage(sql, principal.workspace_id, { id: run.id, state: "unknown" });
            }
          }
          break;
        case "return_control":
          await sql`UPDATE assistant.vms SET control_state=${event.status === "applied" ? "agent" : "unknown"} WHERE id=${principal.vm_id}`;
          if (event.status === "applied" && event.resume_safe !== true && event.execution_continues !== true) {
            await sql`UPDATE assistant.tasks SET state='queued',updated_at=now() WHERE id IN (SELECT task_id FROM assistant.runs WHERE vm_id=${principal.vm_id} AND state='paused') AND state='paused'`;
            await sql`UPDATE assistant.runs SET state='succeeded',updated_at=now() WHERE vm_id=${principal.vm_id} AND state='paused' AND task_id IN (SELECT id FROM assistant.tasks WHERE state='queued')`;
          }
          break;
        default:
          unreachable(command.kind);
      }
      await sql`UPDATE assistant.commands SET status=${event.status},detail=${event.detail},acked_at=now() WHERE id=${command.id}`;
      break;
    }
    case "input_applied": {
      const run = await loadRun(sql, principal, event.run_id);
      const rows =
        await sql`SELECT m.id FROM assistant.messages m JOIN assistant.tasks t ON t.conversation_id=m.conversation_id AND t.workspace_id=m.workspace_id WHERE m.id=${event.message_id} AND t.id=${run.task_id} AND m.workspace_id=${principal.workspace_id}`;
      if (!rows[0]) throw new DomainError("not_found", "Task input not found", 404);
      await sql`INSERT INTO assistant.input_receipts(workspace_id,run_id,message_id) VALUES(${principal.workspace_id},${run.id},${event.message_id}) ON CONFLICT DO NOTHING`;
      break;
    }
    default:
      unreachable(event);
  }
  await sql`INSERT INTO assistant.events(workspace_id,vm_id,event_id,kind,payload) VALUES(${principal.workspace_id},${principal.vm_id},${event.event_id},${event.kind},${JSON.stringify(event)}::text::jsonb)`;
  await recordEvent(sql, {
    workspace: principal.workspace_id,
    kind: `daemon.${event.kind}`,
    payload: JSON.stringify(event),
  });
}
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortObject(item)]),
    );
  return value;
}
