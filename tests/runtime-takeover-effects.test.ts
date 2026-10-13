import { test } from "bun:test";
import { shellTakeoverScenario } from "./runtime-takeover-shell-fixture.ts";

test("desktop takeover preserves a running shell effect through completion without replay", async () => {
  await shellTakeoverScenario(false);
});
