import { z } from 'zod';
import { Id } from '../types';
export const McpConfig = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1).max(1000),
    args: z.string().max(2000).array().max(40),
  }),
  z.object({ transport: z.literal('http'), url: z.string() }),
]);
export type McpConfig = z.infer<typeof McpConfig>;
const observed = {
  revision: z.coerce.number(),
  observed_revision: z.coerce.number().nullable(),
  state: z.enum(['pending', 'ready', 'connected', 'disabled', 'error']),
  tool_count: z.coerce.number(),
  error_code: z.string().nullable(),
  observed_at: z.string().nullable(),
  updated_at: z.string(),
};
export const Skill = z.object({
  id: Id,
  vm_id: Id,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  enabled: z.boolean(),
  archived_at: z.string().nullable().optional(),
  agent_authored: z.boolean().optional(),
  source_excerpt: z.string().nullable().optional(),
  ...observed,
});
export type Skill = z.infer<typeof Skill>;
export const Server = z.object({
  id: Id,
  vm_id: Id,
  name: z.string(),
  enabled: z.boolean(),
  config: McpConfig,
  category: z.enum(['web', 'computer', 'code', 'memory', 'other']).nullable().default(null),
  disabled_tools: z.string().array().default([]),
  tools: z.object({ name: z.string(), description: z.string() }).array().default([]),
  secret_keys: z.string().array(),
  ...observed,
});
export type Server = z.infer<typeof Server>;
export const Extensions = z.object({ skills: Skill.array(), servers: Server.array() });
export type Extensions = z.infer<typeof Extensions>;
export const Persona = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().max(2000),
  style: z.string().max(2000),
});
export type Persona = z.infer<typeof Persona>;
export const Instructions = z.object({
  revision: Id,
  instructions: z.string(),
  persona: Persona,
  onboarding: z
    .object({ status: z.enum(['pending', 'completed', 'skipped']), updated_at: z.string().nullable() })
    .optional(),
});
export type Instructions = z.infer<typeof Instructions>;
export type SkillDraft = Pick<Skill, 'name' | 'description' | 'content' | 'enabled'>;
export type SecretMode = 'keep' | 'replace' | 'clear';
export type SecretField = { id: string; key: string; value: string };
