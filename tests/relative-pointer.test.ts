import { expect, test } from "bun:test";
import { createComputerPointer } from "../apps/web/src/computerPointer";
import { ScreenInput } from "../packages/screen/input";
import { Input } from "../packages/screen/protocol";

test("hidden or non-finite video geometry cannot enqueue relative movement", () => {
  const messages: unknown[] = [];
  const pointer = createComputerPointer(message => messages.push(message));
  for (const width of [0, NaN, Infinity, -1]) {
    for (const action of ["down", "move", "up"] as const)
      pointer.handle({ id: 1, kind: "touch", action, button: 0, x: 20, y: 20, time: 100, bounds: { left: 0, top: 0, width, height: 200 } }, "trackpad");
  }
  expect(messages).toEqual([]);
});

test("throttled relative samples and final up accumulate, reverse at bounds and regrab", () => {
  const messages: ReturnType<typeof Input.parse>[] = [];
  const pointer = createComputerPointer(message => messages.push(Input.parse(message)));
  const move = (action: "down" | "move" | "up", x: number, time: number) => pointer.handle({ id: 1, kind: "touch", action, button: 0, x, y: 50, time, bounds: { left: 0, top: 0, width: 400, height: 200 } }, "trackpad");
  move("down", 10, 100);
  move("move", 20, 110);
  move("move", 30, 111);
  move("move", 40, 112);
  move("up", 50, 113);
  expect(messages.filter(m => m.type === "pointer_relative").reduce((sum, m) => sum + m.dx, 0)).toBeCloseTo(0.1);
  messages.length = 0;
  move("down", 50, 500); move("move", 850, 510); move("move", 890, 511); move("move", 870, 512); move("up", 870, 513);
  let remote = 990;
  for (const message of messages) if (message.type === "pointer_relative") remote = Math.min(1000, Math.max(0, remote + message.dx * 1000));
  expect(remote).toBe(950);
  expect(messages.every(m => m.type === "pointer_relative")).toBe(true);
  messages.length = 0;
  move("down", 10, 1000); move("move", 30, 1010); move("move", 34, 1011); pointer.release(); pointer.release();
  expect(messages.filter(m => m.type === "pointer_relative").reduce((sum, m) => sum + m.dx, 0)).toBeCloseTo(0.06);
});

test("relative receiver rejects invalid deltas and agent input, retains subpixel motion, releases drag", async () => {
  let control: "user" | "agent" = "user";
  const calls: string[][] = [];
  const receiver = new ScreenInput({ owner: { control: () => control }, dimensions: { width: 1001, height: 501 }, execute: async args => { calls.push([...args]); } });
  for (let i = 0; i < 10; i++) await receiver.receive(JSON.stringify({ type: "pointer_relative", dx: 0.0001, dy: 0 }));
  expect(calls).toEqual([["mousemove_relative", "--", "1", "0"]]);
  await receiver.receive(JSON.stringify({ type: "pointer_button", action: "down", button: 2 }));
  control = "agent";
  await expect(receiver.receive(JSON.stringify({ type: "pointer_relative", dx: 0.1, dy: 0 }))).rejects.toThrow("user_control_required");
  await expect(receiver.receive(JSON.stringify({ type: "pointer_button", action: "down", button: 0 }))).rejects.toThrow("user_control_required");
  for (const dx of [1.1, -1.1, "1", null]) await expect(receiver.receive(JSON.stringify({ type: "pointer_relative", dx, dy: 0 }))).rejects.toThrow();
  await receiver.releaseInputs();
  expect(calls).toContainEqual(["mouseup", "3"]);
});

test("first trackpad tap preserves an arbitrary remote position, including after takeover", async () => {
  let x = 713, y = 81;
  const calls: string[][] = [];
  const receiver = new ScreenInput({ owner: { control: () => "user" }, dimensions: { width: 1001, height: 501 }, execute: async (args) => {
    calls.push([...args]);
    if (args[0] === "mousemove") { x = Number(args[1]); y = Number(args[2]); }
    if (args[0] === "mousemove_relative") { x += Number(args[2]); y += Number(args[3]); }
  }});
  const messages: unknown[] = [];
  const pointer = createComputerPointer(message => messages.push(message));
  const tap = (time: number) => {
    for (const action of ["down", "up"] as const) pointer.handle({ id: 1, kind: "touch", action, button: 0, x: 10, y: 10, time: time + (action === "up" ? 10 : 0), bounds: { left: 0, top: 0, width: 400, height: 200 } }, "trackpad");
  };
  tap(100);
  for (const message of messages.splice(0)) await receiver.receive(JSON.stringify(message));
  expect([x, y]).toEqual([713, 81]);
  pointer.release(); x = 909; y = 320;
  tap(500);
  for (const message of messages) await receiver.receive(JSON.stringify(message));
  expect([x, y]).toEqual([909, 320]);
  expect(calls.every(args => args[0] === "mousedown" || args[0] === "mouseup")).toBe(true);
});
