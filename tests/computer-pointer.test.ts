import { expect, test } from "bun:test";
import { createComputerPointer } from "../apps/web/src/computerPointer";
import { Input } from "../packages/screen/protocol";
function setup(mode: "trackpad" | "direct" = "trackpad") {
  const messages: ReturnType<typeof Input.parse>[] = [];
  const pointer = createComputerPointer((message) => messages.push(Input.parse(message)));
  let time = 100;
  const event = (
    action: "down" | "move" | "up",
    x: number,
    y = 100,
    id = 1,
    kind = "touch",
    button = 0,
  ) => {
    time += 40;
    pointer.handle(
      {
        action,
        x,
        y,
        id,
        kind,
        button,
        time,
        bounds: { left: 0, top: 0, width: 400, height: 200 },
      },
      mode,
    );
  };
  return { pointer, messages, event };
}
test("trackpad moves relative to retained cursor, taps click without jumping to finger", () => {
  const { event, messages } = setup();
  event("down", 100);
  event("move", 140);
  event("up", 140);
  expect(messages).toEqual([{ type: "pointer_relative", dx: 0.1, dy: 0 }]);
  event("down", 20);
  event("up", 20);
  expect(messages.slice(-2)).toEqual(
    (["down", "up"] as const).map((action) => ({
      type: "pointer_button",
      button: 0,
      action,
    })),
  );
});
test("double tap hold drags and cancel releases exactly once", () => {
  const { event, messages, pointer } = setup();
  event("down", 100);
  event("up", 100);
  event("down", 100);
  event("move", 180);
  pointer.release();
  pointer.release();
  expect(messages.filter((m) => m.type === "pointer_button" && m.action === "down")).toHaveLength(2);
  expect(messages.filter((m) => m.type === "pointer_button" && m.action === "up")).toHaveLength(2);
  expect(messages.at(-1)).toMatchObject({ type: "pointer_button", action: "up" });
  expect(messages).toContainEqual({ type: "pointer_relative", dx: 0.2, dy: 0 });
});
test("two-finger tap right clicks without a left click; two-finger scroll does not click", () => {
  for (const mode of ["trackpad", "direct"] as const) {
    const { event, messages } = setup(mode);
    event("down", 100);
    event("down", 140, 100, 2);
    event("up", 100);
    event("up", 140, 100, 2);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => (m.type === "pointer" || m.type === "pointer_button") && m.button === 2)).toBe(true);
  }
  const { event, messages } = setup();
  event("down", 100);
  event("down", 140, 100, 2);
  event("move", 100, 20);
  event("move", 140, 20, 2);
  event("up", 100, 20);
  event("up", 140, 20, 2);
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.every((m) => m.type === "scroll")).toBe(true);
});
test("direct dragging maps location, three-finger/cancel never clicks, mouse capture release works", () => {
  const direct = setup("direct");
  direct.event("down", 40, 40);
  direct.event("move", 80, 60);
  direct.event("up", 80, 60);
  expect(direct.messages[0]).toMatchObject({ action: "down", x: 0.1, y: 0.2 });
  expect(direct.messages.at(-1)).toMatchObject({ action: "up", x: 0.2, y: 0.3 });
  const multi = setup();
  multi.event("down", 10);
  multi.event("down", 20, 100, 2);
  multi.event("down", 30, 100, 3);
  multi.event("up", 10);
  multi.event("up", 20, 100, 2);
  multi.event("up", 30, 100, 3);
  expect(multi.messages).toEqual([]);
  const mouse = setup();
  mouse.event("down", 40, 40, 1, "mouse", 2);
  mouse.pointer.release();
  expect(mouse.messages.at(-1)).toMatchObject({ action: "up", button: 2 });
});
