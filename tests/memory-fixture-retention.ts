import { z } from "zod";
import type { Database } from "../services/control/db";
import type { Principal } from "../services/control/auth";
import { persistExtraction as persist } from "../packages/memory/persist";
import { retentionContext } from "../packages/memory/retention-store";
import { inputHash, type ExtractionRequest } from "../packages/memory/schema";
// These existing fixtures test provenance and corrections, not natural-language policy classification.
export async function persistFixtureExtraction(sql: Database, principal: Principal, request: ExtractionRequest) {
  const task = z.object({ task_id: z.uuid() }).parse((await sql`SELECT task_id FROM assistant.runs WHERE id=${request.run_id}`)[0]);
  const context = await retentionContext(sql, { workspace: principal.workspace_id, task: task.task_id });
  const retention = { input_hash: await inputHash(context.sources), decisions: context.sources.map(s => context.decisions.find(d => d.source_message_id === s.id) ?? { source_message_id: s.id, action: "inherit" as const, quote: null }) };
  return persist(sql, principal, { ...request, retention });
}
