import { expect, test } from "bun:test";
import { ScreenInput } from "../packages/screen/input";

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
