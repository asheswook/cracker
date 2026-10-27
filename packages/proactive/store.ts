import { z } from "zod";
import { hashToken, type Principal } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { recordEvent } from "../../services/control/repository/common.ts";
import { DomainError } from "../protocol/index.ts";
import { ownedRun, records } from "./records.ts";
import { applyMutation } from "./write.ts";
import { CancelRequest, CompleteRequest, ListRequest, MutationResult, UpdateRequest } from "./schema.ts";

export type Mutation =
  | { readonly kind: "update"; readonly body: z.infer<typeof UpdateRequest> }
  | { readonly kind: "cancel"; readonly body: z.infer<typeof CancelRequest> }
  | { readonly kind: "complete"; readonly body: z.infer<typeof CompleteRequest> };
export async function listFutureWork(
  sql: Database,
  principal: Principal,
  body: z.infer<typeof ListRequest>,
) {
  await ownedRun(sql, principal, body.run_id);
  const items = (await records(sql, principal, body)).sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
  );
  const page = items.slice(0, 10);
  const last = page.at(-1);
  return { items: page, next_cursor: items.length > 10 && last ? `${last.kind}:${last.id}` : null };
}

export async function mutateFutureWork(sql: Database, principal: Principal, mutation: Mutation) {
  return sql.begin(async (tx) => {
    const { body } = mutation;
    await tx`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR UPDATE`;
    const requestHash = await hashToken(JSON.stringify(mutation));
    const prior = (
      await tx`SELECT vm_id,request_hash,result FROM assistant.proactive_mutations WHERE workspace_id=${principal.workspace_id} AND client_action_id=${body.client_action_id}`
    )[0];
    if (prior) {
      const receipt = z
        .object({ vm_id: z.uuid(), request_hash: z.string(), result: MutationResult })
        .parse(prior);
      if (receipt.vm_id !== principal.vm_id || receipt.request_hash !== requestHash)
        throw new DomainError("idempotency_conflict", "Action key reused", 409);
      return receipt.result;
    }
    const run = await ownedRun(tx, principal, body.run_id);
    const target = mutation.kind === "update" ? mutation.body.work : mutation.body.target;
    const source = (
      await tx`SELECT id FROM assistant.messages WHERE workspace_id=${principal.workspace_id} AND task_id=${run.task_id} AND id=${body.source_message_id} AND role='user' AND position(${body.source_quote} IN content)>0`
    )[0];
    // An automatic action can close only its own responsibility, using its system message
    // as the source and quoting the completion evidence retained in the mutation receipt.
    const ownAction = !source && mutation.kind === "complete" && target.kind === "responsibility" && mutation.body.evidence.includes(body.source_quote) && (
      await tx`SELECT a.id FROM assistant.responsibility_actions a JOIN assistant.responsibilities r ON r.id=a.responsibility_id JOIN assistant.messages m ON m.workspace_id=a.workspace_id AND m.task_id=a.task_id WHERE a.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND a.responsibility_id=${target.id} AND a.task_id=${run.task_id} AND m.id=${body.source_message_id}`
    )[0];
    if (!source && !ownAction)
      throw new DomainError("invalid_source", "Exact current task user source required", 409);
    const current = (await records(tx, principal, target))[0];
    if (!current) throw new DomainError("not_found", "Future work not found on this VM", 404);
    if (current.version !== target.expected_version)
      throw new DomainError("stale_version", "Future work changed; list again before editing", 409);
    if (mutation.kind === "complete" && current.kind === "schedule")
      throw new DomainError("invalid_request", "Only responsibilities can be completed", 400);
    if (!["active", "pending"].includes(current.state))
      throw new DomainError("inactive", "Future work is no longer active", 409);
    const result = await applyMutation(tx, { principal, current }, mutation);
    await tx`INSERT INTO assistant.proactive_mutations(workspace_id,client_action_id,vm_id,request_hash,result,request) VALUES(${principal.workspace_id},${body.client_action_id},${principal.vm_id},${requestHash},${JSON.stringify(result)}::text::jsonb,${JSON.stringify(mutation)}::text::jsonb)`;
    await recordEvent(tx, {
      workspace: principal.workspace_id,
      kind: `${current.kind}.${mutation.kind === "update" ? "updated" : mutation.kind === "complete" ? "completed" : "cancelled"}`,
      payload: JSON.stringify({ id: current.id, source_message_id: body.source_message_id, ...(mutation.kind === "complete" ? { evidence: mutation.body.evidence } : {}) }),
    });
    return result;
  });
}
