import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const Observation = z.object({
  action_id: z.string(), run_id: z.string(), tool_name: z.string(),
  arguments_sha256: z.string(), started_at: z.string(), completed_at: z.string().nullable(),
  frames: z.array(z.object({ sha256: z.string(), encoded_bytes: z.number().int() })),
  image_count: z.number().int(), image_delivery: z.enum(["pending", "none", "appended", "budget_rejected"]),
});
export type ToolObservation = z.infer<typeof Observation>;
export class ToolObservations {
  constructor(private readonly db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS tool_observations(action TEXT PRIMARY KEY,run TEXT NOT NULL,payload TEXT NOT NULL)");
  }
  started(call: { readonly action_id: string; readonly run_id: string; readonly tool_name: string; readonly arguments: string }): void {
    const observation: ToolObservation = {
      action_id: call.action_id, run_id: call.run_id, tool_name: call.tool_name,
      arguments_sha256: fingerprint(call.arguments), started_at: new Date().toISOString(), completed_at: null,
      frames: [], image_count: 0, image_delivery: "pending",
    };
    this.db.transaction(() => {
      this.db.query("INSERT INTO tool_observations VALUES(?,?,?)").run(call.action_id, call.run_id, JSON.stringify(observation));
      this.db.exec("DELETE FROM tool_observations WHERE rowid NOT IN (SELECT rowid FROM tool_observations ORDER BY rowid DESC LIMIT 1024)");
    })();
  }
  completed(action: string, capture: { readonly images: readonly string[]; readonly delivery: "none" | "appended" | "budget_rejected" }): void {
    const row = z.object({ payload: z.string() }).nullable().parse(this.db.query("SELECT payload FROM tool_observations WHERE action=?").get(action));
    if (!row) return;
    const observation = Observation.parse(JSON.parse(row.payload));
    this.db.query("UPDATE tool_observations SET payload=? WHERE action=?").run(JSON.stringify({
      ...observation, completed_at: new Date().toISOString(), image_count: capture.images.length, image_delivery: capture.delivery,
      frames: capture.images.slice(0, 8).map(image => ({ sha256: fingerprint(image), encoded_bytes: Buffer.byteLength(image) })),
    } satisfies ToolObservation), action);
  }
  forRun(run: string): readonly ToolObservation[] {
    return z.array(z.object({ payload: z.string() })).parse(this.db.query("SELECT payload FROM tool_observations WHERE run=? ORDER BY rowid").all(run))
      .map(row => Observation.parse(JSON.parse(row.payload)));
  }
}
