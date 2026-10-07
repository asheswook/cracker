import { persistRetention } from "./retention-store";
import { retentionAllows } from "./retention";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError } from "../protocol/index.ts";
import type { AppEnv, Principal } from "../../services/control/auth.ts";
import type { Database, Transaction } from "../../services/control/db.ts";
import { ExtractionRequest, inputHash, validateClaim, MemoryError, type Claim, type Source } from "./schema.ts";
const RowId = z.object({ id: z.uuid() });
const SourceRow = z.object({ id: z.uuid(), role: z.enum(["user", "assistant", "system"]), content: z.string(), created_at: z.string(), sequence: z.coerce.number().int() });
export async function persistExtraction(sql: Database, principal: Principal, request: ExtractionRequest): Promise<{ readonly accepted: boolean; readonly count: number }> {
  if (principal.role !== "vm") throw new DomainError("forbidden", "VM principal required", 403);
  return sql.begin(async tx => {
    await tx`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR UPDATE`;
    const rows = await tx`SELECT t.conversation_id,t.id AS task_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id WHERE r.id=${request.run_id} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id}`;
    if (!rows[0]) throw new DomainError("not_found", "Run not found", 404);
    const task = z.object({ conversation_id: z.uuid(), task_id: z.uuid() }).parse(rows[0]);
    const conversation = task.conversation_id;
    await tx`SELECT id FROM assistant.conversations WHERE id=${conversation} FOR UPDATE`;
    const sources = z.array(SourceRow).parse(await tx`SELECT id,role,content,created_at,sequence FROM assistant.messages WHERE workspace_id=${principal.workspace_id} AND task_id=${task.task_id} AND conversation_id=${conversation} AND id IN ${tx(request.source_ids)} ORDER BY sequence`);
    if (sources.length !== new Set(request.source_ids).size || await inputHash(sources) !== request.input_hash) throw new DomainError("source_mismatch", "Source snapshot does not match persisted messages", 409);
    const retention = await persistRetention(tx, { workspace: principal.workspace_id, task: task.task_id }, request.retention);
    const previous = await tx`SELECT id,input_hash FROM assistant.memory_derivations WHERE workspace_id=${principal.workspace_id} AND (id=${request.derivation_id} OR input_hash=${request.input_hash})`;
    if (previous[0]) {
      const row = z.object({ input_hash: z.string() }).parse(previous[0]);
      if (row.input_hash !== request.input_hash) throw new DomainError("idempotency_conflict", "Derivation ID reused", 409);
      return { accepted: true, count: 0 };
    }
    for (const claim of request.extraction.claims) {
      const source = sources.find(s => s.id === claim.evidence.source_message_id);
      if (!source) throw new DomainError("source_mismatch", "Claim references absent source", 400);
      try { validateClaim(claim, source); }
      catch (error) { if (error instanceof MemoryError) throw new DomainError(error.code, error.message, 400); throw error; }
    }
    await tx`INSERT INTO assistant.memory_derivations(id,workspace_id,run_id,input_hash) VALUES(${request.derivation_id},${principal.workspace_id},${request.run_id},${request.input_hash})`;
    let count = 0;
    for (const claim of request.extraction.claims) {
      const source = sources.find(s => s.id === claim.evidence.source_message_id);
      if (!source) throw new DomainError("source_mismatch", "Claim references absent source", 400);
      if (!retentionAllows(retention, retention.decisions, source.sequence)) continue;
      if ((await tx`SELECT source_message_id FROM assistant.memory_suppressions WHERE workspace_id=${principal.workspace_id} AND source_message_id=${source.id}`)[0]) continue;
      if (await insertClaim(tx, { workspace: principal.workspace_id, conversation, derivation: request.derivation_id, source }, claim)) count++;
    }
    return { accepted: true, count };
  });
}
type ClaimScope = { readonly workspace: string; readonly conversation: string; readonly derivation: string; readonly source: Source };
async function insertClaim(tx: Transaction, scope: ClaimScope, claim: Claim): Promise<boolean> {
  const context = RowId.parse((await tx`INSERT INTO assistant.memory_contexts(workspace_id,conversation_id,scope_key) VALUES(${scope.workspace},${scope.conversation},${claim.context}) ON CONFLICT(workspace_id,conversation_id,scope_key) DO UPDATE SET scope_key=EXCLUDED.scope_key RETURNING id`)[0]).id;
  const corrected=await tx`SELECT a.id FROM assistant.memory_assertions a JOIN assistant.memory_entities e ON e.id=a.entity_id JOIN assistant.memories m ON m.id=a.id WHERE a.workspace_id=${scope.workspace} AND a.context_id=${context} AND a.source_message_id=${scope.source.id} AND a.predicate=${claim.predicate} AND e.canonical_name=${claim.entity} AND (a.typed_value=${JSON.stringify({value:claim.value,unit:claim.unit})}::text::jsonb OR m.text=${claim.text}) AND EXISTS(SELECT 1 FROM assistant.memory_corrections o WHERE o.workspace_id=a.workspace_id AND o.root_memory_id=a.id)`;
  if(corrected[0])return false;
  const duplicate = await tx`SELECT a.id FROM assistant.memory_assertions a JOIN assistant.memories m ON m.id=a.id WHERE a.workspace_id=${scope.workspace} AND a.context_id=${context} AND a.source_message_id=${scope.source.id} AND a.predicate=${claim.predicate} AND m.text=${claim.text}`;
  if (duplicate[0]) return false;
  const entity = RowId.parse((await tx`INSERT INTO assistant.memory_entities(workspace_id,context_id,canonical_name,source_message_id) VALUES(${scope.workspace},${context},${claim.entity},${scope.source.id}) RETURNING id`)[0]).id;
  await tx`INSERT INTO assistant.memory_episodes(id,workspace_id,source_role,observed_at,content_hash) VALUES(${scope.source.id},${scope.workspace},${scope.source.role},${scope.source.created_at},${await inputHash([scope.source])}) ON CONFLICT DO NOTHING`;
  if (claim.supersedes_id) {
    const older = await tx`SELECT m.id FROM assistant.memories m LEFT JOIN assistant.memory_corrections o ON o.workspace_id=m.workspace_id AND o.id=m.id JOIN assistant.memory_assertions a ON a.id=COALESCE(o.root_memory_id,m.id) WHERE m.id=${claim.supersedes_id} AND m.workspace_id=${scope.workspace} AND a.context_id=${context} AND a.predicate=${claim.predicate} AND m.deleted_at IS NULL AND ((o.id IS NULL AND a.known_to IS NULL) OR (o.id IS NOT NULL AND o.known_to IS NULL)) AND NOT EXISTS(SELECT 1 FROM assistant.memory_corrections n WHERE n.workspace_id=m.workspace_id AND n.supersedes_id=m.id)`;
    if (!older[0]) throw new DomainError("invalid_correction", "Correction must reference active same-context predicate", 409);
    await tx`UPDATE assistant.memory_assertions SET known_to=now() WHERE id=${claim.supersedes_id}`;
    await tx`UPDATE assistant.memory_corrections SET known_to=now() WHERE workspace_id=${scope.workspace} AND id=${claim.supersedes_id}`;
  }
  const id = crypto.randomUUID();
  await tx`INSERT INTO assistant.memories(id,workspace_id,text,source_message_id) VALUES(${id},${scope.workspace},${claim.text},${scope.source.id})`;
  await tx`INSERT INTO assistant.memory_assertions(id,workspace_id,context_id,entity_id,predicate,typed_value,epistemic_status,source_message_id,source_span,lineage_root_id,derivation_id,valid_from,valid_to,time_precision,supersedes_id) VALUES(${id},${scope.workspace},${context},${entity},${claim.predicate},${JSON.stringify({ value: claim.value, unit: claim.unit })}::text::jsonb,${claim.epistemic_status},${scope.source.id},${claim.evidence.quote},${scope.source.id},${scope.derivation},${claim.valid_from},${claim.valid_to},${claim.time_precision},${claim.supersedes_id})`;
  switch (claim.kind) {
    case "assertion": break;
    case "decision": await tx`INSERT INTO assistant.memory_decisions(id,workspace_id,assertion_id) VALUES(${crypto.randomUUID()},${scope.workspace},${id})`; break;
    case "commitment": await tx`INSERT INTO assistant.memory_commitments(id,workspace_id,assertion_id,due_at,due_timezone) VALUES(${crypto.randomUUID()},${scope.workspace},${id},${claim.due_at},${claim.due_timezone})`; break;
    default: assertNever(claim.kind);
  }
  return true;
}
export function memoryDaemonRoutes(sql: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/", async c => c.json(await persistExtraction(sql, c.get("principal"), ExtractionRequest.parse(await c.req.json()))));
  return app;
}
function assertNever(value: never): never { throw new MemoryError(`unknown_claim:${String(value)}`); }
export async function retrieveMemory(sql: import("../../services/control/db.ts").Query, workspace: string, conversation: string): Promise<readonly { readonly id: string; readonly text: string }[]> {
  return z.array(z.object({ id: z.uuid(), text: z.string() })).parse(await sql`
    SELECT m.id,CASE WHEN o.id IS NOT NULL THEN '[reported; user_correction; original_memory=' || o.root_memory_id::text || CASE WHEN a.id IS NULL THEN '' ELSE '; context=' || c.scope_key || '; predicate=' || a.predicate || '; source=' || a.source_message_id::text END || '] ' || m.text
      WHEN a.id IS NULL THEN m.text ELSE '[' || a.epistemic_status || '; context=' || c.scope_key || '; predicate=' || a.predicate || '; source=' || a.source_message_id::text || '] ' || m.text END AS text
    FROM assistant.memories m LEFT JOIN assistant.memory_corrections o ON o.workspace_id=m.workspace_id AND o.id=m.id
    LEFT JOIN assistant.memory_assertions a ON a.workspace_id=m.workspace_id AND a.id=COALESCE(o.root_memory_id,m.id) LEFT JOIN assistant.memory_contexts c ON c.id=a.context_id
    WHERE m.workspace_id=${workspace} AND m.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM assistant.memory_corrections n WHERE n.workspace_id=m.workspace_id AND n.supersedes_id=m.id)
      AND (m.source_message_id IS NULL OR NOT EXISTS(SELECT 1 FROM assistant.memory_suppressions s WHERE s.workspace_id=m.workspace_id AND s.source_message_id=m.source_message_id))
      AND ((o.id IS NOT NULL AND o.known_to IS NULL AND (o.conversation_id IS NULL OR o.conversation_id=${conversation}))
        OR (o.id IS NULL AND ((a.id IS NULL AND (m.source_message_id IS NULL OR EXISTS(SELECT 1 FROM assistant.messages sm WHERE sm.id=m.source_message_id AND sm.conversation_id=${conversation})))
          OR (c.conversation_id=${conversation} AND a.known_to IS NULL AND (a.valid_from IS NULL OR a.valid_from<=now()) AND (a.valid_to IS NULL OR a.valid_to>now())))))
    ORDER BY m.created_at DESC LIMIT 100`);
}
