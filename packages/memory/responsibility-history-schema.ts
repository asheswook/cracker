import { z } from "zod";
import { Task } from "../protocol";

export const ResponsibilityRun = z.object({
  id: z.uuid(),
  state: z.enum(["pending", "dispatched", "cancelled"]),
  created_at: z.string(),
  scheduled_for: z.string().nullable(),
  task: Task.nullable(),
});
export const ResponsibilityHistoryQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const ResponsibilityHistory = z.object({
  runs: ResponsibilityRun.array(),
  next_cursor: z.uuid().nullable(),
});
