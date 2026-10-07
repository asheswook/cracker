import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolObservations } from "../services/daemon/tool-observations.ts";
test("tool observations persist frame identity, delivery and uncertain execution without retaining payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-observations-"));
  const path = join(directory, "journal.sqlite");
  let db = new Database(path);
  try {
    const observations = new ToolObservations(db);
    for (const action_id of ["first", "second", "uncertain"]) observations.started({ action_id, run_id: "run", tool_name: "computer_exec", arguments: "secret-token=credential" });
    observations.completed("first", { images: ["private-frame-A", "private-frame-B"], delivery: "appended" });
    observations.completed("second", { images: ["private-frame-A"], delivery: "budget_rejected" });
    db.close(); db = new Database(path);
    const recovered = new ToolObservations(db).forRun("run");
    expect(recovered.map(item => item.image_delivery)).toEqual(["appended", "budget_rejected", "pending"]);
    expect(recovered[0]?.frames[0]?.sha256).toBe(recovered[1]?.frames[0]?.sha256);
    expect(recovered[0]?.frames[0]?.sha256).not.toBe(recovered[0]?.frames[1]?.sha256);
    expect(recovered[2]?.completed_at).toBeNull();
    expect(recovered[0]?.completed_at).toBeTruthy();
    expect(recovered[0]?.frames[0]?.encoded_bytes).toBe(15);
    expect(JSON.stringify(db.query("SELECT * FROM tool_observations").all())).not.toMatch(/credential|secret-token|private-frame/);
    expect(new ToolObservations(db).forRun("other")).toEqual([]);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
test("tool observation storage is bounded across runs and image batches", () => {
  const db = new Database(":memory:");
  try {
    const observations = new ToolObservations(db);
    for (let i = 0; i < 1025; i++) observations.started({ action_id: String(i), run_id: "run", tool_name: "computer", arguments: "{}" });
    observations.completed("1024", { images: Array.from({ length: 20 }, (_, i) => String(i)), delivery: "appended" });
    const rows = observations.forRun("run");
    expect(rows).toHaveLength(1024);
    expect(rows[0]?.action_id).toBe("1");
    expect(rows.at(-1)?.frames).toHaveLength(8);
    expect(rows.at(-1)?.image_count).toBe(20);
  } finally { db.close(); }
});
