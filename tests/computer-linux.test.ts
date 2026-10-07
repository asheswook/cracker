import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runComputer } from "../services/daemon/computer.ts";

const enabled = process.platform === "linux" && process.env["RUN_LINUX_ACCEPTANCE"] === "1";
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("X11 event timeout")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function desktop() {
  const display = spawn(
    "Xvfb",
    ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp", "-ac"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const address = `:${String((await bounded(once(display.stdout, "data")))[0]).trim()}`;
  const previous = process.env["DISPLAY"];
  process.env["DISPLAY"] = address;
  const events = spawn(
    "stdbuf",
    ["-oL", "xev", "-geometry", "400x300+0+0", "-event", "button", "-event", "mouse"],
    { env: { ...process.env, DISPLAY: address }, stdio: ["ignore", "pipe", "ignore"] },
  );
  let output = "";
  const changed = new Set<() => void>();
  events.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    for (const notify of changed) notify();
  });
  const wait = async (predicate: (value: string) => boolean) => {
    if (predicate(output)) return;
    const ready = Promise.withResolvers<void>();
    const notify = () => {
      if (predicate(output)) ready.resolve();
    };
    changed.add(notify);
    try {
      await bounded(ready.promise);
    } finally {
      changed.delete(notify);
    }
  };
  await wait((value) => value.includes("Outer window"));
  return {
    wait,
    output: () => output,
    close: async () => {
      events.kill("SIGTERM");
      display.kill("SIGTERM");
      await Promise.all([bounded(once(events, "exit")), bounded(once(display, "exit"))]);
      if (previous === undefined) delete process.env["DISPLAY"];
      else process.env["DISPLAY"] = previous;
    },
  };
}

for (const [action, buttons] of [
  ["click", [1]],
  ["double_click", [1, 1]],
  ["right_click", [3]],
] as const) {
  test.skipIf(!enabled)(`${action} produces the expected actual X11 button events`, async () => {
    const fixture = await desktop();
    try {
      await runComputer(
        JSON.stringify({ action, x: 150, y: 150, text: "" }),
        new AbortController().signal,
      );
      await fixture.wait(
        (value) => (value.match(/ButtonRelease event/g) ?? []).length === buttons.length,
      );
      expect(
        [...fixture.output().matchAll(/ButtonPress event[\s\S]*?button (\d+)/g)].map((match) =>
          Number(match[1]),
        ),
      ).toEqual([...buttons]);
    } finally {
      await fixture.close();
    }
  });
}

test.skipIf(!enabled)("drag reaches its endpoint and releases the actual X11 button", async () => {
  const fixture = await desktop();
  try {
    await runComputer(
      JSON.stringify({ action: "drag", x: 150, y: 150, end_x: 220, end_y: 210, text: "" }),
      new AbortController().signal,
    );
    await fixture.wait((value) => value.includes("ButtonRelease event"));
    expect(fixture.output()).toMatch(/ButtonRelease event[\s\S]*?root:\(220,210\)[\s\S]*?button 1/);
  } finally {
    await fixture.close();
  }
});

test.skipIf(!enabled)("cancelled drag releases the button before returning", async () => {
  const fixture = await desktop();
  const controller = new AbortController();
  try {
    const action = runComputer(
      JSON.stringify({ action: "drag", x: 150, y: 150, end_x: 220, end_y: 210, text: "" }),
      controller.signal,
    );
    const outcome = action.then(
      () => "completed",
      (error) => (error instanceof Error ? error.message : "unknown"),
    );
    await fixture.wait((value) => value.includes("ButtonPress event"));
    controller.abort();
    expect(await outcome).toBe("aborted");
    await fixture.wait((value) => value.includes("ButtonRelease event"));
    expect(fixture.output()).toMatch(/ButtonRelease event[\s\S]*?button 1/);
  } finally {
    controller.abort();
    await fixture.close();
  }
});

test("drag with a missing endpoint rejects before invoking a desktop command", async () => {
  await expect(
    runComputer(
      JSON.stringify({ action: "drag", x: 1, y: 1, text: "" }),
      new AbortController().signal,
    ),
  ).rejects.toThrow("Drag requires an end position");
});
