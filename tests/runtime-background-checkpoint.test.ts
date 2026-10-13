import { test } from "bun:test";
import { shellTakeoverScenario } from "./runtime-takeover-shell-fixture.ts";

test("desktop takeover preserves a yielded shell session and its pending provider", async () => {
  await shellTakeoverScenario(true);
});
