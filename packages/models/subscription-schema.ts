import { z } from "zod";

export const SubscriptionProvider = z.enum(["claude", "codex", "antigravity", "kimi", "xai"]);
export const SubscriptionModel = z.object({ id: z.string().min(1).max(120), owned_by: z.string().max(200) });
export const SubscriptionAccount = z.object({ provider: z.string().max(100), label: z.string().max(500), status: z.string().max(100) });
export const SubscriptionState = z.string().min(1).max(512);
export const SubscriptionAuthorization = z.url().max(8000).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
    !["access_token", "refresh_token", "id_token", "id_token_hint"].some(key => url.searchParams.has(key));
});
export const SubscriptionCallback = z.url().max(8000).refine(value => {
  const url = new URL(value), keys = ["code", "state", "error", "error_description", "scope", "provider"];
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username && !url.password && !url.hash && Boolean(url.searchParams.get("state")) &&
    Boolean(url.searchParams.get("code")) !== Boolean(url.searchParams.get("error")) &&
    [...url.searchParams.keys()].every(key => keys.includes(key) && url.searchParams.getAll(key).length === 1);
}, "Paste the final localhost callback URL");
export const SubscriptionCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("catalogue") }).strict(),
  z.object({ action: z.literal("login"), provider: SubscriptionProvider, location: z.enum(["vm", "local"]) }).strict(),
  z.object({ action: z.literal("status"), state: SubscriptionState }).strict(),
  z.object({ action: z.literal("callback"), state: SubscriptionState, redirect_url: SubscriptionCallback }).strict(),
]);
export type SubscriptionCommand = z.infer<typeof SubscriptionCommand>;
export const SubscriptionResult = z.discriminatedUnion("action", [
  z.object({ action: z.literal("catalogue"), models: z.array(SubscriptionModel).max(2000), accounts: z.array(SubscriptionAccount).max(1000) }).strict(),
  z.object({ action: z.literal("login"), url: SubscriptionAuthorization, state: SubscriptionState }).strict(),
  z.object({ action: z.literal("status"), status: z.enum(["wait", "ok", "error"]) }).strict(),
  z.object({ action: z.literal("callback"), accepted: z.literal(true) }).strict(),
]);
export type SubscriptionResult = z.infer<typeof SubscriptionResult>;
export const SubscriptionReply = z.object({ request_id: z.uuid(), status: z.enum(["pending", "running", "completed", "failed"]), result: SubscriptionResult.nullable() });
export const SubscriptionClaim = z.object({ request_id: z.uuid(), command: SubscriptionCommand });
