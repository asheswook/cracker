import { z } from "zod";
const Name = z.string().trim().min(1).max(64);
export const McpConfig = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string().min(1).max(1000), args: z.array(z.string().max(2000)).max(40) }).strict(),
  z.object({ transport: z.literal("http"), url: z.url().max(2000).refine(value => { const u = new URL(value); return (u.protocol === "https:" || (u.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(u.hostname))); }, "HTTPS URL or loopback HTTP required") }).strict()
]);
export const SkillInput = z.object({ id: z.uuid().optional(), vm_id: z.uuid(), name: Name, description: z.string().trim().min(1).max(1000), content: z.string().min(1).max(65536), enabled: z.boolean(), expected_revision:z.number().int().positive().optional(), origin_message_id:z.uuid().optional() }).strict();
export const ServerInput = z.object({ id: z.uuid().optional(), vm_id: z.uuid(), name: Name, config: McpConfig, enabled: z.boolean(), secrets: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/),z.string().max(8192).refine(value=>!/[\r\n\0]/.test(value))).refine(value=>Object.keys(value).length<=30).optional() }).strict();
const Observed = { revision: z.coerce.number().int(), observed_revision: z.coerce.number().int().nullable(), state:z.enum(["pending","ready","connected","disabled","error"]), tool_count:z.coerce.number().int(), error_code:z.string().nullable(), observed_at:z.string().nullable(), updated_at:z.string() };
export const Skill = SkillInput.omit({id:true,expected_revision:true,origin_message_id:true}).extend({ id:z.uuid(), archived_at:z.string().nullable().default(null), ...Observed }).strip();
export const Server = ServerInput.omit({id:true,secrets:true}).extend({ id:z.uuid(), secret_keys:z.array(z.string()), ...Observed }).strip();
export const SkillMetadata = Skill.omit({content:true});
export const Manifest = z.object({ skills:z.array(SkillMetadata), servers:z.array(Server.extend({secrets:z.record(z.string(),z.string())})) });
export const Observation = z.object({ kind:z.enum(["skill","server"]), id:z.uuid(), revision:z.number().int().positive(), state:z.enum(["ready","connected","disabled","error"]), tool_count:z.number().int().min(0).max(500), error_code:z.enum(["connect_failed","disconnected","tool_list_failed","invalid_config","authentication_failed","access_denied","endpoint_not_found","rate_limited","server_unavailable","connection_timeout","command_not_found"]).nullable() }).strict();
export type McpConfig = z.infer<typeof McpConfig>;
