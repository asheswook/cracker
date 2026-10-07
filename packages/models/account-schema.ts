import { z } from "zod";
export const AccountState = z.enum(["unknown", "disconnected", "connected", "requires_login", "connecting"]);
export const AccountAction = z.enum(["connect", "disconnect"]);
export const LoginLocation = z.enum(["vm", "local"]);
export const LocalRedirect = z.url().max(200).pipe(z.string().refine(value => {
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) && url.pathname === "/auth/callback" && !url.username && !url.password && !url.search && !url.hash;
}, "Local login requires a loopback callback"));
export const AccountError = z.enum(["login_failed", "login_timeout", "login_interrupted", "revocation_unconfirmed", "credential_error", "browser_unavailable"]);
export const AccountStatus = z.object({ state: AccountState, request_id: z.uuid().nullable(), action: AccountAction.nullable(), request_status: z.enum(["pending", "running", "completed", "failed"]).nullable(), error_code: AccountError.nullable(), updated_at: z.string().nullable(), login_location: LoginLocation.default("vm") });
export const AccountRequest = z.object({ vm_id: z.uuid(), request_id: z.uuid(), action: AccountAction, login_location: LoginLocation.default("vm"), redirect_uri: LocalRedirect.optional() }).strict().refine(value => value.action === "connect" && value.login_location === "local" ? Boolean(value.redirect_uri) : value.login_location === "vm" && value.redirect_uri === undefined, "Invalid login location");
export const AccountObservation = z.object({ request_id: z.uuid().nullable(), state: AccountState, error_code: AccountError.nullable() }).strict();
export const ClaimedAccountRequest = z.object({ request_id: z.uuid(), action: AccountAction, login_location: LoginLocation.default("vm"), redirect_uri: LocalRedirect.nullable().optional() });
export const LocalCallback = z.object({ state: z.string().min(16).max(512), code: z.string().min(1).max(4096).optional(), client_id: z.string().min(1).max(256).optional(), error: z.string().min(1).max(256).optional() }).strict().refine(value => Boolean(value.code) !== Boolean(value.error), "Callback needs a code or error");
