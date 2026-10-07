import ky, { HTTPError } from "ky";
import { z } from "zod";
import { hashToken } from "../services/control/auth.ts";
export async function sessionRemoteSmoke(): Promise<void> {
  const connection = z.object({ control_url: z.url(), workspace_id: z.uuid(), vm_id: z.uuid(), client_token: z.string(), vm_token: z.string() }).parse(await Bun.file(".local/remote-connection.json").json());
  const origin = new URL(connection.control_url).origin;
  const api = ky.create({ prefixUrl: origin, retry: 0, timeout: 20000, throwHttpErrors: false });
  const statuses: Record<string, number | boolean> = {};
  const login = await api.post("v1/session", { headers: { Origin: origin }, json: { token: connection.client_token } });
  statuses["login"] = login.status;
  const setCookie = login.headers.get("set-cookie") ?? "", cookie = setCookie.split(";")[0] ?? "";
  statuses["protected_cookie"] = ["HttpOnly", "Secure", "SameSite=Strict", "Path=/v1"].every(attribute => setCookie.includes(attribute));
  statuses["read"] = (await api.get("v1/session", { headers: { Cookie: cookie } })).status;
  statuses["csrf_cross_origin"] = (await api.post("v1/conversations", { headers: { Cookie: cookie, Origin: "https://attacker.invalid" }, json: { title: "must-reject" } })).status;
  statuses["csrf_missing_origin"] = (await api.post("v1/conversations", { headers: { Cookie: cookie }, json: { title: "must-reject" } })).status;
  statuses["cookie_mutation"] = (await api.post("v1/conversations", { headers: { Cookie: cookie, Origin: origin }, json: { title: "Session remote smoke" } })).status;
  statuses["logout"] = (await api.delete("v1/session", { headers: { Cookie: cookie, Origin: origin } })).status;
  statuses["logout_replay"] = (await api.get("v1/session", { headers: { Cookie: cookie } })).status;
  statuses["vm_login"] = (await api.post("v1/session", { headers: { Origin: origin }, json: { token: connection.vm_token } })).status;
  const secret = z.string().min(32).parse((await Bun.file("infra/provision/.dev.vars").text()).trim().split("=")[1]);
  const disposable = crypto.randomUUID() + crypto.randomUUID(), disposableHash = await hashToken(disposable);
  const setup = { workspace_id: connection.workspace_id, vm_id: connection.vm_id, vm_hash: await hashToken(connection.vm_token), client_hash: disposableHash };
  await ky.post("http://127.0.0.1:8789/install", { headers: { Authorization: `Bearer ${secret}` }, json: setup, retry: 0, timeout: 60000 });
  try {
    const temporary = await api.post("v1/session", { headers: { Origin: origin }, json: { token: disposable } });
    if (temporary.status !== 200) throw new TypeError("Temporary login failed");
    const tempCookie = (temporary.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await ky.post("http://127.0.0.1:8789/install", { headers: { Authorization: `Bearer ${secret}` }, json: { ...setup, revoke_client_hash: disposableHash }, retry: 0, timeout: 60000 });
    statuses["parent_revocation"] = (await api.get("v1/session", { headers: { Cookie: tempCookie } })).status;
  } finally {
    await ky.post("http://127.0.0.1:8789/install", { headers: { Authorization: `Bearer ${secret}` }, json: { ...setup, revoke_client_hash: disposableHash }, retry: 0, timeout: 60000 });
  }
  const expected = { login: 200, protected_cookie: true, read: 200, csrf_cross_origin: 403, csrf_missing_origin: 403, cookie_mutation: 201, logout: 200, logout_replay: 401, vm_login: 403, parent_revocation: 401 };
  for (const [name, value] of Object.entries(expected)) if (statuses[name] !== value) throw new TypeError(`Unexpected status for ${name}`);
  console.log(JSON.stringify({ verified_at: new Date().toISOString(), surface: origin, statuses }));
}
if (import.meta.main) {
  try { await sessionRemoteSmoke(); }
  catch (error) { console.error(JSON.stringify({ failed: true, type: error instanceof Error ? error.name : "unknown", status: error instanceof HTTPError ? error.response.status : null })); process.exitCode = 1; }
}
