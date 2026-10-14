import { z } from "zod";
import type { Query } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
export const SkillBinding = z.object({
  skill_id: z.uuid(),
  revision: z.number().int().positive(),
  content_hash: z.string(),
  name: z.string(),
});
export const Version = z.object({
  skill_id: z.uuid(),
  revision: z.coerce.number().int(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  content_hash: z.string(),
  origin_message_id: z.uuid().nullable(),
  agent_authored: z.boolean().default(false),
  created_at: z.string(),
});
export async function ownedVersion(
  sql: Query,
  workspace: string,
  id: string,
  revision: number,
  vm?: string,
) {
  const rows =
    await sql`SELECT v.*,s.vm_id FROM assistant.skill_versions v JOIN assistant.extension_skills s ON s.id=v.skill_id AND s.workspace_id=v.workspace_id WHERE v.workspace_id=${workspace} AND v.skill_id=${id} AND v.revision=${revision} AND (${vm ?? null}::uuid IS NULL OR s.vm_id=${vm ?? null})`;
  if (!rows[0]) throw new DomainError("not_found", "Skill version not found", 404);
  return Version.extend({ vm_id: z.uuid() }).parse(rows[0]);
}
export async function taskSkill(sql: Query, workspace: string, task: string) {
  const rows =
    await sql`SELECT v.skill_id,v.revision,v.content_hash,v.name FROM assistant.skill_executions e JOIN assistant.skill_versions v ON v.workspace_id=e.workspace_id AND v.skill_id=e.skill_id AND v.revision=e.revision WHERE e.workspace_id=${workspace} AND e.task_id=${task}`;
  return rows[0] ? SkillBinding.parse(rows[0]) : undefined;
}
export async function bindSkill(
  sql: Query,
  input: {
    workspace: string;
    task: string;
    message: string;
    skill: string;
    revision: number;
    kind: "test" | "scheduled";
    clientId?: string;
  },
) {
  const version = await ownedVersion(sql, input.workspace, input.skill, input.revision);
  return z
    .object({ id: z.uuid() })
    .parse(
      (
        await sql`INSERT INTO assistant.skill_executions(workspace_id,skill_id,revision,vm_id,task_id,input_message_id,kind,client_execution_id) VALUES(${input.workspace},${input.skill},${input.revision},${version.vm_id},${input.task},${input.message},${input.kind},${input.clientId ?? null}) RETURNING id`
      )[0],
    );
}
