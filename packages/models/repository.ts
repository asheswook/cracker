import { z } from "zod";
import type { Principal } from "../../services/control/auth.ts";
import type { Query } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import { seal, unseal } from "../extensions/secrets.ts";
import { ModelAccess, ModelBinding, ModelDefaults, ModelSelection, ModelSettings, SaveModelSettings } from "./schema.ts";

const Revision = z.object({ id: z.uuid(), selection: ModelSelection, secret_cipher: z.string().nullable() });
export type ModelScope = { readonly workspace: string; readonly vm: string };

export async function ownModelVm(sql: Query, scope: ModelScope): Promise<void> {
  const rows = await sql`SELECT id FROM assistant.vms WHERE id=${scope.vm} AND workspace_id=${scope.workspace} FOR UPDATE`;
  if (!rows[0]) throw new DomainError("not_found", "Computer not found", 404);
}
async function latest(sql: Query, scope: ModelScope) {
  return Revision.optional().parse((await sql`SELECT id,selection,secret_cipher FROM assistant.model_revisions WHERE workspace_id=${scope.workspace} AND vm_id=${scope.vm} ORDER BY created_at DESC,id DESC LIMIT 1`)[0]);
}
async function defaults(sql: Query, scope: ModelScope) {
  const row = (await sql`SELECT configuration FROM assistant.vm_model_defaults WHERE workspace_id=${scope.workspace} AND vm_id=${scope.vm}`)[0];
  return row ? ModelDefaults.parse(row["configuration"]) : null;
}
export async function modelSettings(sql: Query, scope: ModelScope) {
  await ownModelVm(sql, scope);
  const revision = await latest(sql, scope);
  const inherited = await defaults(sql, scope);
  const saved = await sql`SELECT DISTINCT selection->>'provider' AS provider FROM assistant.model_revisions WHERE workspace_id=${scope.workspace} AND vm_id=${scope.vm} AND secret_cipher IS NOT NULL`;
  return ModelSettings.parse({
    vm_id: scope.vm,
    binding: revision ? { revision_id: revision.id, selection: revision.selection } : inherited ? { revision_id: null, selection: inherited.selection } : null,
    defaults: inherited,
    saved_credentials: saved.map(row => row["provider"]),
  });
}
export async function saveModel(sql: Query, scope: { readonly workspace: string; readonly encryptionKey: string | undefined }, input: z.infer<typeof SaveModelSettings>) {
  const vmScope = { workspace: scope.workspace, vm: input.vm_id };
  await ownModelVm(sql, vmScope);
  const previous = await latest(sql, vmScope);
  if ((previous?.id ?? null) !== input.expected_revision_id)
    throw new DomainError("stale_revision", "Model settings changed. Reload before saving.", 409);
  const inherited = await defaults(sql, vmScope);
  if (!inherited) throw new DomainError("model_runtime_unavailable", "The computer has not reported model-settings support yet", 409);
  if (input.selection.provider === "chatgpt" && input.api_key)
    throw new DomainError("invalid_request", "ChatGPT uses the computer's connected account", 400);
  const stored = input.selection.provider === "chatgpt" ? undefined : (await sql`SELECT secret_cipher FROM assistant.model_revisions WHERE workspace_id=${scope.workspace} AND vm_id=${input.vm_id} AND selection->>'provider'=${input.selection.provider} AND secret_cipher IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`)[0];
  const cipher = input.api_key ? await seal({ api_key: input.api_key }, scope.encryptionKey) : z.string().nullable().parse(stored?.["secret_cipher"] ?? null);
  if (!cipher && !inherited?.available.includes(input.selection.provider))
    throw new DomainError("model_connection_required", "Connect this provider before saving the model", 409);
  await sql`INSERT INTO assistant.model_revisions(workspace_id,vm_id,selection,secret_cipher) VALUES(${scope.workspace},${input.vm_id},${JSON.stringify(input.selection)}::text::jsonb,${cipher})`;
  return modelSettings(sql, vmScope);
}
export async function pinRunModel(sql: Query, scope: ModelScope, runId: string): Promise<void> {
  const revision = await latest(sql, scope);
  const inherited = revision ? null : await defaults(sql, scope);
  const selection = revision?.selection ?? inherited?.selection;
  if (!selection) return;
  await sql`INSERT INTO assistant.run_models(run_id,revision_id,selection,secret_cipher) VALUES(${runId},${revision?.id ?? null},${JSON.stringify(selection)}::text::jsonb,${revision?.secret_cipher ?? null})`;
}
export async function runModelBinding(sql: Query, principal: Principal, runId: string): Promise<ModelBinding | undefined> {
  const row = (await sql`SELECT m.revision_id,m.selection FROM assistant.run_models m JOIN assistant.runs r ON r.id=m.run_id WHERE r.id=${runId} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id}`)[0];
  return ModelBinding.optional().parse(row);
}
export async function accessRunModel(sql: Query, scope: { readonly principal: Principal; readonly encryptionKey: string | undefined }, runId: string): Promise<ModelAccess> {
  const p = scope.principal;
  const run = (await sql`SELECT m.revision_id,m.selection,m.secret_cipher FROM assistant.runs r LEFT JOIN assistant.run_models m ON m.run_id=r.id WHERE r.id=${runId} AND r.workspace_id=${p.workspace_id} AND r.vm_id=${p.vm_id}`)[0];
  if (!run) throw new DomainError("not_found", "Run not found", 404);
  if (!run["selection"]) return { binding: null, api_key: null };
  const secrets = await unseal(z.string().nullable().parse(run["secret_cipher"]), scope.encryptionKey);
  return { binding: ModelBinding.parse(run), api_key: secrets["api_key"] ?? null };
}
export async function accessCurrentModel(sql: Query, scope: ModelScope & { readonly encryptionKey: string | undefined }): Promise<ModelAccess> {
  const revision = await latest(sql, scope), inherited = revision ? null : await defaults(sql, scope);
  const secrets = await unseal(revision?.secret_cipher ?? null, scope.encryptionKey);
  return { binding: revision ? { revision_id: revision.id, selection: revision.selection } : inherited ? { revision_id: null, selection: inherited.selection } : null, api_key: secrets["api_key"] ?? null };
}
