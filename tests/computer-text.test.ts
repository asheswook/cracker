import { expect, test } from "bun:test";
import { splitComputerText } from "../apps/web/src/computerText";
import { Input } from "../packages/screen/protocol";

test("splits oversized paste at the actual protocol bound without splitting emoji or losing literal text", () => {
  const text = "a".repeat(4095) + "😀" + "한글\n\t!".repeat(1800);
  const chunks = splitComputerText(text);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.join("")).toBe(text);
  expect(chunks[0]).toHaveLength(4095);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(chunk.isWellFormed()).toBe(true);
    expect(Input.parse({ type: "text", text: chunk }).type).toBe("text");
  }
});
test("keeps normal text intact and emits no empty chunk", () => {
  expect(splitComputerText("")).toEqual([]);
  expect(splitComputerText("한글 😀\n\t")).toEqual(["한글 😀\n\t"]);
  expect(splitComputerText("a".repeat(4096))).toEqual(["a".repeat(4096)]);
});
