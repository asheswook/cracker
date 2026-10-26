import { z } from "zod";
const Timezone = z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch (error) { if (error instanceof RangeError) return false; throw error; } }, "Invalid timezone");
const DailyTimezone = Timezone.transform(value => new Intl.DateTimeFormat("en", {timeZone:value}).resolvedOptions().timeZone).refine(value => !/^[+-]/.test(value), "Daily schedules require an IANA timezone or UTC, not a numeric offset");
export const QuietHours = z.object({ start_hour: z.number().int().min(0).max(23), end_hour: z.number().int().min(0).max(23), timezone: Timezone });
export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deadline"), due_at: z.iso.datetime(), timezone: Timezone }),
  z.object({ kind: z.literal("task_change"), task_id: z.uuid() }),
  z.object({ kind: z.literal("daily"), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), timezone: DailyTimezone }),
  z.object({ kind: z.literal("periodic"), interval_minutes: z.number().int().min(5).max(10080) })
]);
export const ResponsibilityInput = z.object({ skill_id:z.uuid().nullable().default(null),skill_revision:z.number().int().positive().nullable().default(null), client_responsibility_id: z.uuid(), conversation_id: z.uuid(), vm_id: z.uuid(), source_message_id: z.uuid(), source_quote: z.string().min(1).max(10000), objective: z.string().min(1).max(4000), title: z.string().trim().max(60).nullable().default(null), trigger: Trigger, notification_mode: z.enum(["enabled", "quiet"]).default("enabled"), quiet_hours: QuietHours.nullable().default(null) });
export const Evaluation = z.object({ outcome: z.enum(["quiet", "notify", "complete", "action"]), reason: z.string().min(1).max(4000), notification: z.string().min(1).max(4000).nullable(), action_objective: z.string().min(1).max(4000).nullable().default(null), next_review_minutes: z.number().int().min(5).max(10080) }).superRefine((value, ctx) => { if ((value.outcome === "notify") !== (value.notification !== null)) ctx.addIssue({ code: "custom", message: "Only notify carries a notification" }); if ((value.outcome === "action") !== (value.action_objective !== null)) ctx.addIssue({ code: "custom", message: "Only action carries an objective" }); });
export const ResponsibilitySnapshot = z.object({ id: z.uuid(), objective: z.string(), trigger: Trigger, context_hash: z.string(), messages: z.array(z.object({ id: z.uuid(), role: z.string(), content: z.string(), created_at: z.string() })), tasks: z.array(z.object({ id: z.uuid(), objective: z.string(), state: z.string(), reason: z.string().nullable() })), history: z.array(z.object({ outcome: z.string(), reason: z.string() })).default([]), notifications: z.array(z.object({ state: z.string(), content: z.string() })).default([]) });
export const EvaluationRequest = z.object({ responsibility_id: z.uuid(), context_hash: z.string().regex(/^[a-f0-9]{64}$/), evaluation: Evaluation });
export type ResponsibilityInput = z.infer<typeof ResponsibilityInput>;
export type ResponsibilitySnapshot = z.infer<typeof ResponsibilitySnapshot>;
export type EvaluationRequest = z.infer<typeof EvaluationRequest>;
export function quietNow(hours: z.infer<typeof QuietHours> | null, date: Date): boolean {
  if (!hours || hours.start_hour === hours.end_hour) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: hours.timezone, hour: "2-digit", hourCycle: "h23" }).format(date));
  return hours.start_hour < hours.end_hour ? hour >= hours.start_hour && hour < hours.end_hour : hour >= hours.start_hour || hour < hours.end_hour;
}
