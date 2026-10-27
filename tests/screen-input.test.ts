import { expect, test } from "bun:test";
import { ScreenInput } from "../packages/screen/input";
import { InputLease } from "../packages/screen/input-lease";
import { ScreenPeer } from "../packages/screen/peer";

test("physical Korean composition keys reach xdotool as paired keys, never text", async () => {
  const calls: string[][] = [];
  const input = new ScreenInput({
    owner: { control: () => "user" }, dimensions: { width: 800, height: 600 },
    execute: async args => { calls.push([...args]); },
    paste: async () => { throw new Error("physical keys must not paste text"); },
  });
  const keys = ["Hangul", "g", "k", "s", "space", "Super_L", "minus", "equal", "bracketleft",
    "bracketright", "backslash", "semicolon", "apostrophe", "comma", "period", "slash", "grave",
    "Caps_Lock", "Hangul_Hanja", "ISO_Level3_Shift", "KP_0", "KP_9", "KP_Add", "KP_Subtract",
    "KP_Multiply", "KP_Divide", "KP_Decimal", "KP_Enter", "less", "yen", "underscore"];
  for (const key of keys) for (const action of ["down", "up"]) {
    await input.receive(JSON.stringify({ type: "key", key, action }));
  }
  expect(calls).toEqual(keys.flatMap(key => [["keydown", key], ["keyup", key]]));
});

test("layout Unicode and dead-key results use the existing literal paste path", async () => {
  const pasted: string[] = [];
  const input = new ScreenInput({
    owner: { control: () => "user" }, dimensions: { width: 800, height: 600 },
    execute: async () => { throw new Error("Unicode must not become physical keys"); },
    paste: async (text, beforeInput) => { beforeInput(); pasted.push(text); },
  });
  for (const text of ["é", "ü", "€", "ê"]) await input.receive(JSON.stringify({ type: "text", text }));
  expect(pasted).toEqual(["é", "ü", "€", "ê"]);
});

test("keyup is queued even when the server input queue is full", async () => {
  const calls: string[][] = [];
  const gate = Promise.withResolvers<void>();
  const input = new ScreenInput({
    owner: { control: () => "user" }, dimensions: { width: 800, height: 600 },
    execute: async args => { calls.push([...args]); await gate.promise; },
  });
  const queued = Array.from({ length: 64 }, () => input.receive(JSON.stringify({ type: "key", key: "a", action: "down" })));
  queued.push(input.receive(JSON.stringify({ type: "key", key: "a", action: "up" })));
  gate.resolve();
  await Promise.all(queued);
  expect(calls.at(-1)).toEqual(["keyup", "a"]);
});

for (const end of ["expire", "return", "disconnect"] as const) {
  test(`lease ${end} releases real held keys server-side`, async () => {
    let now = 1000;
    let owner: "user" | "agent" = "user";
    const journal = { control: () => owner };
    const calls: string[][] = [];
    const input = new ScreenInput({ owner: journal, dimensions: { width: 800, height: 600 },
      execute: async args => { calls.push([...args]); } });
    const lease = new InputLease(journal, () => now);
    lease.register("viewer", { visible: () => true, changed: () => {}, release: () => input.releaseInputs() });
    const epoch = await lease.claim("viewer");
    await input.receive(JSON.stringify({ type: "key", key: "Control_L", action: "down" }), () => lease.permits("viewer", epoch));
    if (end === "disconnect") await lease.unregister("viewer");
    else {
      if (end === "return") owner = "agent";
      else now += 30001;
      await lease.expire();
    }
    expect(calls).toEqual([["keydown", "Control_L"], ["keyup", "Control_L"]]);
  });
}

test("peer disconnection releases held keys even without a viewer lease", async () => {
  const calls: string[][] = [];
  const peer = new ScreenPeer({ owner: { control: () => "user" }, dimensions: { width: 160, height: 120 },
    iceServers: [], visible: false, signal: () => {}, execute: async args => { calls.push([...args]); },
    capture: async () => async () => {} });
  try {
    await peer.input.receive(JSON.stringify({ type: "key", key: "Shift_L", action: "down" }));
    peer.pc.connectionStateChange.execute("disconnected");
    await Bun.sleep(0);
    expect(calls).toEqual([["keydown", "Shift_L"], ["keyup", "Shift_L"]]);
  } finally { await peer.close(); }
});

test("input-channel closure revokes the lease and releases keys while the peer stays connected", async () => {
  const calls: string[][] = [];
  const owner = { control: () => "user" as const };
  const lease = new InputLease(owner);
  const peer = new ScreenPeer({ owner, dimensions: { width: 160, height: 120 },
    viewer: { id: "viewer", version: 2, lease }, iceServers: [], signal: () => {},
    execute: async args => { calls.push([...args]); }, capture: async () => async () => {} });
  try {
    peer.pc.connectionStateChange.execute("connected");
    const channel = peer.pc.createDataChannel("input");
    peer.pc.onDataChannel.execute(channel);
    const epoch = await lease.claim("viewer");
    await peer.input.receive(JSON.stringify({ type: "key", key: "Alt_L", action: "down" }), () => lease.permits("viewer", epoch));
    channel.stateChange.execute("closed");
    await Bun.sleep(0);
    expect(lease.permits("viewer", epoch)).toBe(false);
    expect(calls).toEqual([["keydown", "Alt_L"], ["keyup", "Alt_L"]]);
  } finally { await peer.close(); }
});

test("rejects viewer input while agent owns the VM", async () => {
  // Given agent ownership and a real input boundary.
  const calls: string[][] = [];
  const input = new ScreenInput({
    owner: { control: () => "agent" },
    dimensions: { width: 800, height: 600 },
    execute: async (args) => {
      calls.push([...args]);
    },
  });
  // When a viewer requests a click.
  const operation = input.receive(
    JSON.stringify({ type: "pointer", x: 0.5, y: 0.5, action: "down" }),
  );
  // Then no OS input command is issued.
  await expect(operation).rejects.toThrow("user_control_required");
  expect(calls).toHaveLength(0);
});
test("maps normalized pointer and releases held key when ownership is returned", async () => {
  // Given a user controlling an 800x600 desktop.
  let control: "agent" | "user" = "user";
  const calls: string[][] = [];
  const input = new ScreenInput({
    owner: { control: () => control },
    dimensions: { width: 800, height: 600 },
    execute: async (args) => {
      calls.push([...args]);
    },
  });
  await input.receive(JSON.stringify({ type: "pointer", x: 1, y: 1, button: 2, action: "down" }));
  await input.receive(JSON.stringify({ type: "key", key: "Control_L", action: "down" }));
  // When control is revoked and inputs are released.
  control = "agent";
  await input.releaseInputs();
  // Then absolute position and button mapping are correct, key/button releases complete.
  expect(calls).toEqual([
    ["mousemove", "799", "599"],
    ["mousedown", "3"],
    ["keydown", "Control_L"],
    ["keyup", "Control_L"],
    ["mouseup", "3"],
  ]);
});
test("rechecks ownership before a queued input reaches the OS", async () => {
  // Given one in-flight command and another waiting behind it.
  let control: "agent" | "user" = "user";
  let release: () => void = () => {
    throw new Error("gate unavailable");
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[][] = [];
  const input = new ScreenInput({
    owner: { control: () => control },
    dimensions: { width: 800, height: 600 },
    execute: async (args) => {
      calls.push([...args]);
      await gate;
    },
  });
  const first = input.receive(JSON.stringify({ type: "text", text: "a" }));
  const second = input.receive(JSON.stringify({ type: "text", text: "b" }));
  await Promise.resolve();
  // When ownership changes before queued input executes.
  control = "agent";
  release();
  await first;
  // Then the queued input is rejected rather than replayed under agent ownership.
  await expect(second).rejects.toThrow("user_control_required");
  expect(calls).toHaveLength(1);
});
test("rejects malformed key and out-of-screen coordinates", async () => {
  // Given user ownership.
  const calls: string[][] = [];
  const input = new ScreenInput({
    owner: { control: () => "user" },
    dimensions: { width: 800, height: 600 },
    execute: async (args) => {
      calls.push([...args]);
    },
  });
  // When untrusted data requests an invalid coordinate or key syntax.
  await expect(
    input.receive(JSON.stringify({ type: "pointer", x: 1.1, y: 0, action: "move" })),
  ).rejects.toThrow();
  await expect(
    input.receive(JSON.stringify({ type: "key", key: "--window 1", action: "down" })),
  ).rejects.toThrow();
  // Then no OS command is executed.
  expect(calls).toHaveLength(0);
});

test("Unicode paste rechecks ownership before triggering the OS paste", async () => {
  let control: "agent" | "user" = "user";
  let pasted = false;
  const input = new ScreenInput({
    owner: { control: () => control },
    dimensions: { width: 800, height: 600 },
    execute: async () => {
      throw new Error("unexpected key typing");
    },
    paste: async (_text, beforeInput) => {
      beforeInput();
      control = "agent";
      beforeInput();
      pasted = true;
    },
  });
  await expect(input.receive(JSON.stringify({ type: "text", text: "한글" }))).rejects.toThrow(
    "user_control_required",
  );
  expect(pasted).toBe(false);
});

test("pastes ASCII multiline and tab text literally instead of executing navigation keys", async () => {
  const pasted: string[] = [];
  const typed: string[][] = [];
  const input = new ScreenInput({
    owner: { control: () => "user" },
    dimensions: { width: 800, height: 600 },
    execute: async (args) => {
      typed.push([...args]);
    },
    paste: async (text, beforeInput) => {
      beforeInput();
      pasted.push(text);
    },
  });
  for (const text of ["line one\nline two", "a\tb", "a\r\nb"])
    await input.receive(JSON.stringify({ type: "text", text }));
  expect(pasted).toEqual(["line one\nline two", "a\tb", "a\r\nb"]);
  expect(typed).toHaveLength(0);
  await input.receive(JSON.stringify({ type: "text", text: "!@# literal" }));
  expect(pasted.at(-1)).toBe("!@# literal");
  await input.receive(JSON.stringify({ type: "text", text: "a" }));
  expect(typed).toEqual([["type", "--clearmodifiers", "--delay", "0", "--", "a"]]);
});


test("pastes a large ASCII batch without flooding the target with synthetic key events", async () => {
  // Given a receiver with both literal-paste and key-event transports.
  const pasted: string[] = [];
  const input = new ScreenInput({
    owner: { control: () => "user" }, dimensions: { width: 800, height: 600 },
    execute: async () => { throw new Error("ASCII batch must not emit key events"); },
    paste: async (text, beforeInput) => { beforeInput(); pasted.push(text); },
  });
  const text = "a".repeat(4096);
  // When the largest protocol text batch arrives.
  await input.receive(JSON.stringify({ type: "text", text }));
  // Then a single exact literal transfer reaches the paste transport.
  expect(pasted).toEqual([text]);
});
