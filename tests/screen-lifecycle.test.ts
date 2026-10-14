import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../services/daemon/journal";
import { parseDaemonConfig } from "../services/daemon/main";

const base = {
  CONTROL_URL: "https://control.example",
  VM_TOKEN: "test-only-vm-token",
  PROVIDER_MODE: "api",
  OPENAI_MODEL: "test-model",
  OPENAI_API_KEY: "test-only-api-key",
};

test("screen remains opt-in and validates enabled VM/display/ICE settings", () => {
  // Given explicit provider settings with screen disabled by default.
  expect(parseDaemonConfig(base).screen).toBeUndefined();
  // When screen is enabled without required VM identity or valid display.
  expect(() => parseDaemonConfig({ ...base, SCREEN_ENABLED: "true" })).toThrow();
  expect(() =>
    parseDaemonConfig({
      ...base,
      SCREEN_ENABLED: "true",
      VM_ID: crypto.randomUUID(),
      DISPLAY: "remote:0",
    }),
  ).toThrow();
  const configured = parseDaemonConfig({
    ...base,
    SCREEN_ENABLED: "true",
    VM_ID: crypto.randomUUID(),
    DISPLAY: ":99",
    SCREEN_ICE_SERVERS:
      '[{"urls":"turn:relay.example:3478","username":"test","credential":"test"}]',
  });
  // Then valid settings are parsed and malformed ICE is rejected.
  expect(configured.screen?.display).toBe(":99");
  expect(configured.screen?.iceServers[0]?.urls).toBe("turn:relay.example:3478");
  expect(() =>
    parseDaemonConfig({
      ...base,
      SCREEN_ENABLED: "true",
      VM_ID: crypto.randomUUID(),
      DISPLAY: ":99",
      SCREEN_ICE_SERVERS: "not-json",
    }),
  ).toThrow();
});
test("rejects insecure remote control and missing selected provider credentials", () => {
  // Given configuration selects one provider, never implicit fallback.
  // When URL is insecure or ChatGPT mode lacks its own token file.
  expect(() => parseDaemonConfig({ ...base, CONTROL_URL: "http://control.example" })).toThrow();
  expect(() => parseDaemonConfig({ ...base, CONTROL_URL: "ftp://localhost" })).toThrow();
  expect(() => parseDaemonConfig({ ...base, PROVIDER_MODE: "chatgpt" })).toThrow();
  // Then API-key presence does not substitute for ChatGPT token-file selection.
  expect(
    parseDaemonConfig({
      ...base,
      PROVIDER_MODE: "chatgpt",
      CHATGPT_TOKEN_FILE: "/private/test.json",
    }).PROVIDER_MODE,
  ).toBe("chatgpt");
});
test("daemon cleanly shuts down its journal after SIGTERM with screen disabled", async () => {
  // Given real daemon child process and a local HTTP control peer with no assigned work.
  const dir = await mkdtemp(join(tmpdir(), "assistant-lifecycle-"));
  const path = join(dir, "journal.sqlite");
  let observed: () => void = () => {
    throw new Error("poll observer missing");
  };
  const polled = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/v1/daemon/session") {
        expect(request.headers.get("x-daemon-session")).not.toBeNull();
        return Response.json({ reconciled: true, epoch: 1, adopted: [], quarantined: [] });
      }
      if (new URL(request.url).pathname === "/v1/daemon/poll") {
        observed();
        return Response.json({ assignment: null, commands: [], messages: [] });
      }
      return Response.json({ accepted: true });
    },
  });
  const child = Bun.spawn(["bun", "services/daemon/main.ts"], {
    env: {
      ...process.env,
      ...base,
      CONTROL_URL: server.url.toString(),
      JOURNAL_PATH: path,
      SCREEN_ENABLED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await polled;
    // When SIGTERM interrupts the polling delay.
    child.kill("SIGTERM");
    const exit = await child.exited;
    // Then process exits successfully, leaves private usable durable journal.
    expect(exit).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
    const journal = new Journal(path);
    expect(journal.interrupted()).toEqual([]);
    journal.close();
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
test("SIGTERM closes the journal during session registration backoff without polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-registration-lifecycle-"));
  const path = join(dir, "journal.sqlite");
  const retrying = Promise.withResolvers<void>();
  let polls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: request => {
      if (new URL(request.url).pathname === "/v1/daemon/session") {
        retrying.resolve();
        return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      }
      polls++;
      return Response.json({ assignment: null, commands: [], messages: [] });
    },
  });
  const child = Bun.spawn(["bun", "services/daemon/main.ts"], {
    env: { ...process.env, ...base, CONTROL_URL: server.url.toString(), JOURNAL_PATH: path, SCREEN_ENABLED: "false" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    await retrying.promise;
    // Allow the rejected registration to enter its abortable retry delay.
    await Bun.sleep(100);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(polls).toBe(0);
    expect(await new Response(child.stderr).text()).toContain("daemon.registration_retry");
    const journal = new Journal(path);
    expect(journal.interrupted()).toEqual([]);
    journal.close();
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
test.skipIf(process.platform === "linux")(
  "Linux screen preflight fails explicitly on this non-Linux host",
  async () => {
    // Given opt-in production screen config on a non-Linux host.
    const child = Bun.spawn(["bun", "services/daemon/main.ts", "--preflight"], {
      env: {
        ...process.env,
        ...base,
        SCREEN_ENABLED: "true",
        VM_ID: crypto.randomUUID(),
        DISPLAY: ":99",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // When startup preflight runs.
    const exit = await child.exited;
    const error = await new Response(child.stderr).text();
    // Then it fails before claiming screen capability.
    expect(exit).toBe(1);
    expect(JSON.parse(error).code).toBe("screen_requires_linux_x11");
  },
);
