import { afterAll, beforeAll, expect, test } from "bun:test";
import ky from "ky";
import { createDatabase } from "../services/control/db";
import { hashToken } from "../services/control/auth";

const adminUrl = process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev";
const databaseName = `screen_ice_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(adminUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = createDatabase(adminUrl);
const sql = createDatabase(isolatedUrl.href);
const workspace = crypto.randomUUID(), vm = crypto.randomUUID(), other = crypto.randomUUID();
const client = crypto.randomUUID() + crypto.randomUUID(), machine = crypto.randomUUID() + crypto.randomUUID();
let created = false;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  created = true;
  const migration = Bun.spawn(["bun", "scripts/migrate.ts"], {
    env: { PATH: process.env["PATH"], DATABASE_URL: isolatedUrl.href }, stdout: "ignore", stderr: "pipe",
  });
  expect(await migration.exited).toBe(0);
  await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'screen-ice-isolated')`;
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'screen-ice-own'),(${other},${workspace},'screen-ice-other')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(client)},${workspace},'client',null),(${await hashToken(machine)},${workspace},'vm',${vm})`;
});
afterAll(async () => {
  await sql.end();
  if (created) await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await admin.end();
});

const configurations = [
  { name: "absent", env: {}, status: 200, mode: "direct" },
  { name: "key-only", env: { SCREEN_TURN_KEY_ID: "test-key" }, status: 503, mode: "invalid" },
  { name: "token-only", env: { SCREEN_TURN_API_TOKEN: "test-only-token" }, status: 503, mode: "invalid" },
  { name: "empty-token", env: { SCREEN_TURN_KEY_ID: "test-key", SCREEN_TURN_API_TOKEN: "" }, status: 503, mode: "invalid" },
  { name: "valid", env: { SCREEN_TURN_KEY_ID: "test-key", SCREEN_TURN_API_TOKEN: "test-only-token" }, status: 200, mode: "turn" },
] as const;

for (const entrypoint of ["services/control/local.ts", "tests/fixtures/screen-ice-worker.ts"]) {
  for (const config of configurations) {
    test(`${entrypoint} isolates ${config.name} TURN settings to authenticated owned screen requests`, async () => {
      // Given the real entrypoint and a disposable database containing only this test's resources.
      const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = reservation.port;
      await reservation.stop(true);
      const child = Bun.spawn(["bun", "--preload", "./tests/fixtures/screen-ice-preload.ts", entrypoint], {
        env: { PATH: process.env["PATH"], DATABASE_URL: isolatedUrl.href, PORT: String(port), ...config.env },
        stdout: "pipe", stderr: "pipe",
      });
      try {
        const reader = child.stdout.getReader();
        const startup = await reader.read();
        reader.releaseLock();
        expect(startup.done).toBe(false);
        const http = ky.create({ prefixUrl: `http://127.0.0.1:${port}`, retry: 0, timeout: 3000, throwHttpErrors: false });
        const headers = { Authorization: `Bearer ${client}` };
        // When health, ordinary authenticated API and screen requests traverse the same running entrypoint.
        const responses = await Promise.all([
          http.get("health"), http.get("v1/session", { headers }), http.get("v1/conversations", { headers }),
          http.post(`v1/vms/${vm}/screen/ice`),
          http.post(`v1/vms/${crypto.randomUUID()}/screen/ice`, { headers }),
          http.post(`v1/daemon/vms/${other}/screen/ice`, { headers: { Authorization: `Bearer ${machine}` } }),
          http.post(`v1/vms/${vm}/screen/ice`, { headers }),
        ]);
        // Then invalid TURN stays explicit on the owned screen path, after authentication and isolation.
        expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 401, 404, 404, config.status]);
        const screen = responses[6];
        if (!screen) throw new TypeError("Screen response missing");
        expect(screen.headers.get("cache-control")).toBe("no-store");
        const body: unknown = await screen.json();
        if (config.status === 503) expect(body).toEqual({ error: { code: "turn_configuration_invalid", message: "TURN configuration is incomplete" } });
        else expect(body).toMatchObject({ mode: config.mode });
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    }, 15000);
  }
}
