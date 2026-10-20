import { beforeAll, afterAll, test, expect } from "bun:test";
import { z } from "zod";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { authenticate, hashToken } from "../services/control/auth.ts";
const sql = createDatabase(process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
const app = createApp(sql), workspace = crypto.randomUUID(), vm = crypto.randomUUID();
const origin = "https://session.test";
beforeAll(async () => {
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'session-test')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'session-vm')`;
});
afterAll(async () => { await sql.end(); });
async function credential(role: "client" | "vm" = "client"): Promise<string> {
  const value = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(value)},${workspace},${role},${role === "vm" ? vm : null})`;
  return value;
}
async function login(token: string, source: string | null = origin): Promise<Response> {
  return app.request(`${origin}/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": crypto.randomUUID(), ...(source ? { Origin: source } : {}) }, body: JSON.stringify({ token }) });
}
function cookie(response: Response): string {
  const header = response.headers.get("set-cookie"); if (!header) throw new TypeError("Expected Set-Cookie");
  return header.split(";")[0] ?? "";
}
test("login issues a protected thirty-day cookie and exposes workspace only", async () => {
  // Given
  const token = await credential();
  // When
  const response = await login(token);
  // Then
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ workspace_id: workspace });
  const header = response.headers.get("set-cookie") ?? "";
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/v1", "Max-Age=2592000"]) expect(header).toContain(attribute);
  expect(header.includes(token)).toBe(false);
});
test("cookie authenticates a read and carries the actual parent credential hash", async () => {
  // Given
  const token = await credential(), session = cookie(await login(token));
  // When
  const response = await app.request(`${origin}/v1/session`, { headers: { Cookie: session } });
  const principal = await authenticate(sql, undefined, session);
  // Then
  expect(response.status).toBe(200); expect(principal.credential_hash).toBe(await hashToken(token));
});
test("unsafe cookie mutation rejects missing Origin", async () => {
  // Given
  const session = cookie(await login(await credential()));
  // When
  const response = await app.request(`${origin}/v1/conversations`, { method: "POST", headers: { Cookie: session, "Content-Type": "application/json" }, body: JSON.stringify({ title: "blocked" }) });
  // Then
  expect(response.status).toBe(403);
});
test("unsafe cookie mutation rejects cross-site Origin", async () => {
  // Given
  const session = cookie(await login(await credential()));
  // When
  const response = await app.request(`${origin}/v1/conversations`, { method: "POST", headers: { Cookie: session, Origin: "https://attacker.test", "Content-Type": "application/json" }, body: JSON.stringify({ title: "blocked" }) });
  // Then
  expect(response.status).toBe(403);
});
test("same-origin cookie mutation succeeds", async () => {
  // Given
  const session = cookie(await login(await credential()));
  // When
  const response = await app.request(`${origin}/v1/conversations`, { method: "POST", headers: { Cookie: session, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ title: "allowed" }) });
  // Then
  expect(response.status).toBe(201);
});
test("login rejects missing Origin before setting any cookie", async () => {
  // Given
  const token = await credential();
  // When
  const response = await login(token, null);
  // Then
  expect(response.status).toBe(403); expect(response.headers.get("set-cookie")).toBeNull();
});
test("VM credential cannot create browser session", async () => {
  // Given
  const token = await credential("vm");
  // When
  const response = await login(token);
  // Then
  expect(response.status).toBe(403); expect(response.headers.get("set-cookie")).toBeNull();
});
test("logout invalidates server-side session immediately", async () => {
  // Given
  const session = cookie(await login(await credential()));
  // When
  const response = await app.request(`${origin}/v1/session`, { method: "DELETE", headers: { Cookie: session, Origin: origin } });
  const replay = await app.request(`${origin}/v1/session`, { headers: { Cookie: session } });
  // Then
  expect(response.status).toBe(200); expect(replay.status).toBe(401);
});
test("parent credential revocation invalidates derived sessions", async () => {
  // Given
  const token = await credential(), session = cookie(await login(token));
  // When
  await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE token_hash=${await hashToken(token)}`;
  const response = await app.request(`${origin}/v1/session`, { headers: { Cookie: session } });
  // Then
  expect(response.status).toBe(401);
});
test("expired browser session is rejected", async () => {
  // Given
  const token = await credential(), session = cookie(await login(token));
  // When
  await sql`UPDATE assistant.browser_sessions SET expires_at=now()-interval '1 second' WHERE credential_hash=${await hashToken(token)}`;
  const response = await app.request(`${origin}/v1/session`, { headers: { Cookie: session } });
  // Then
  expect(response.status).toBe(401);
});
test("an active session slides forward once less than half its lifetime remains", async () => {
  // Given
  const token = await credential(), session = cookie(await login(token));
  await sql`UPDATE assistant.browser_sessions SET expires_at=now()+interval '2 days' WHERE credential_hash=${await hashToken(token)}`;
  // When
  const response = await app.request(`${origin}/v1/session`, { headers: { Cookie: session } });
  // Then
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=2592000");
  const left = z.object({ days: z.number() }).parse((await sql`SELECT (extract(epoch FROM expires_at-now())/86400)::float8 AS days FROM assistant.browser_sessions WHERE credential_hash=${await hashToken(token)}`)[0]);
  expect(left.days).toBeGreaterThan(29);
});
test("re-login moves this browser's push subscription to the new session", async () => {
  // Given
  const token = await credential(), first = cookie(await login(token)), firstHash = await hashToken(first.split("=")[1] ?? "");
  const installation = crypto.randomUUID();
  await sql`INSERT INTO assistant.push_subscriptions(id,workspace_id,credential_hash,session_hash,installation_id,subscription_cipher,enabled,transport,subscription_hash) VALUES(${crypto.randomUUID()},${workspace},${await hashToken(token)},${firstHash},${installation},'cipher',true,'web',${crypto.randomUUID()})`;
  // When
  const second = cookie(await app.request(`${origin}/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": crypto.randomUUID(), Origin: origin, Cookie: first }, body: JSON.stringify({ token }) }));
  // Then
  const row = (await sql`SELECT session_hash FROM assistant.push_subscriptions WHERE installation_id=${installation}`)[0];
  expect(row?.["session_hash"]).toBe(await hashToken(second.split("=")[1] ?? ""));
});
test("logout turns off push for the session's subscriptions", async () => {
  // Given
  const token = await credential(), session = cookie(await login(token)), installation = crypto.randomUUID();
  await sql`INSERT INTO assistant.push_subscriptions(id,workspace_id,credential_hash,session_hash,installation_id,subscription_cipher,enabled,transport,subscription_hash) VALUES(${crypto.randomUUID()},${workspace},${await hashToken(token)},${await hashToken(session.split("=")[1] ?? "")},${installation},'cipher',true,'web',${crypto.randomUUID()})`;
  // When
  const response = await app.request(`${origin}/v1/session`, { method: "DELETE", headers: { Cookie: session, Origin: origin } });
  // Then
  expect(response.status).toBe(200);
  expect((await sql`SELECT enabled FROM assistant.push_subscriptions WHERE installation_id=${installation}`)[0]?.["enabled"]).toBe(false);
});
test("bearer API remains usable without browser Origin", async () => {
  // Given
  const token = await credential();
  // When
  const response = await app.request(`${origin}/v1/conversations`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "bearer" }) });
  // Then
  expect(response.status).toBe(201);
});
test("explicit local development Origin works only when configured", async () => {
  // Given
  const development = createApp(sql, { allowedOrigins: ["http://localhost:5173"] }), token = await credential();
  // When
  const response = await development.request("http://localhost:8787/v1/session", { method: "POST", headers: { Origin: "http://localhost:5173", "Content-Type": "application/json", "cf-connecting-ip": crypto.randomUUID() }, body: JSON.stringify({ token }) });
  // Then
  expect(response.status).toBe(200); expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
});
test("sign-in rejects oversized body before authentication", async () => {
  // Given
  const body = JSON.stringify({ token: "x".repeat(5000) });
  // When
  const response = await app.request(`${origin}/v1/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
  // Then
  expect(response.status).toBe(413);
});
test("distributed sign-in attempt bucket enforces its limit", async () => {
  // Given
  const address = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
  // When
  const responses = [];
  for (let index = 0; index < 11; index++) responses.push(await app.request(`${origin}/v1/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "cf-connecting-ip": address }, body: JSON.stringify({ token }) }));
  // Then
  expect(responses.map(r => r.status)).toEqual([...Array(10).fill(401), 429]);
  expect(responses.at(-1)?.headers.get("retry-after")).toBe("60");
});
