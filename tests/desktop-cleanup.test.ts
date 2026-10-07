import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentDesktop } from "../services/daemon/desktop-session";

test("attempts release after kill failure and keeps the session poisoned", async () => {
  // Given a real child process and a release executable recording its invocation.
  const directory = await mkdtemp(join(tmpdir(), "desktop-cleanup-"));
  const marker = join(directory, "released");
  await Bun.write(join(directory, "python3"), `#!/bin/sh\nprintf released > '${marker}'\n`);
  await chmod(join(directory, "python3"), 0o700);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = directory;
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
    detached: true,
  });
  await once(child.stdout, "data");
  const session = new PersistentDesktop();
  session["worker"] = child;
  const original = process.kill.bind(process);
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGTERM") throw Object.assign(new Error("denied"), { code: "EPERM" });
    return original(pid, signal);
  });
  try {
    // When graceful termination fails, forced termination still succeeds.
    await expect(session.close()).rejects.toThrow("desktop_termination_failed");
    // Then release ran, and neither reset nor a new operation erases the failure.
    expect(await Bun.file(marker).text()).toBe("released");
    await expect(session.reset(directory)).rejects.toThrow("desktop_termination_failed");
    await expect(
      session.run(JSON.stringify({ code: "return 1;" }), new AbortController().signal),
    ).rejects.toThrow("desktop_termination_failed");
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    kill.mockRestore();
    if (child.exitCode === null && child.signalCode === null)
      original(-Number(child.pid), "SIGKILL");
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("records asynchronous cleanup failure and rejects all later callers", async () => {
  // Given an exited real child and a release helper that fails.
  const directory = await mkdtemp(join(tmpdir(), "desktop-release-failure-"));
  await Bun.write(join(directory, "python3"), "#!/bin/sh\nexit 1\n");
  await chmod(join(directory, "python3"), 0o700);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = directory;
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true });
  await once(child, "exit");
  const session = new PersistentDesktop();
  session["worker"] = child;
  const messages: unknown[] = [];
  let reported: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    reported = resolve;
  });
  const logger = spyOn(console, "error").mockImplementation((message: unknown) => {
    messages.push(message);
    reported?.();
  });
  try {
    // When an idle protocol callback requests background cleanup.
    session["stopInBackground"]();
    await observed;
    // Then the error is observable and remains terminal for future cleanup and work.
    expect(messages).toEqual([
      JSON.stringify({ event: "desktop_cleanup_failed", code: "desktop_input_release_failed" }),
    ]);
    await expect(session.close()).rejects.toThrow("desktop_input_release_failed");
    await expect(
      session.run(JSON.stringify({ code: "return 1;" }), new AbortController().signal),
    ).rejects.toThrow("desktop_input_release_failed");
  } finally {
    logger.mockRestore();
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}, 5000);
