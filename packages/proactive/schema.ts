import { z } from "zod";
import { QuietHours, Trigger } from "../memory/responsibility-schema.ts";

const Target = z.object({
  kind: z.enum(["schedule", "responsibility"]),
  id: z.uuid(),
  expected_version: z.string().regex(/^[a-f0-9]{64}$/),
});
const Source = z.object({
  source_message_id: z.uuid(),
  source_quote: z.string().min(1).max(10000),
});
export const ScheduleConfiguration = z.object({
  title: z.string().trim().max(60).nullable().transform(v => v || null),
  objective: z.string().min(1).max(100000),
  due_at: z.iso.datetime({ offset: true }),
  timezone: z.string().min(1).max(100),
});
export const ResponsibilityConfiguration = z.object({
  title: z.string().trim().max(60).nullable().transform(v => v || null),
  until_at: z.iso.datetime({ offset: true }).nullable().describe("For daily/periodic only: ISO end date, or null for no end date."),
  objective: z.string().min(1).max(4000),
  trigger: Trigger,
  notification_mode: z.enum(["enabled", "quiet"]),
  quiet_hours: QuietHours.nullable(),
});
export const FutureWorkListInput = z.object({
  query: z.string().max(500).nullable(),
  include_inactive: z.boolean(),
  cursor: z
    .string()
    .regex(/^(schedule|responsibility):[a-f0-9-]{36}$/)
    .nullable(),
});
export const FutureWorkUpdateInput = Source.extend({
  work: z.discriminatedUnion("kind", [
    Target.extend({ kind: z.literal("schedule"), configuration: ScheduleConfiguration }),
    Target.extend({
      kind: z.literal("responsibility"),
      configuration: ResponsibilityConfiguration,
    }),
  ]),
});
export const FutureWorkCancelInput = Source.extend({ target: Target });
const Metadata = z.object({
  id: z.uuid(),
  version: z.string(),
  state: z.string(),
  conversation_id: z.uuid(),
  next_due_at: z.string(),
  skill_id: z.uuid().nullable(),
  skill_revision: z.number().int().nullable(),
});
export const FutureWork = z.discriminatedUnion("kind", [
  Metadata.extend({ kind: z.literal("schedule"), configuration: ScheduleConfiguration }),
  Metadata.extend({
    kind: z.literal("responsibility"),
    configuration: ResponsibilityConfiguration,
  }),
]);
export const MutationResult = z.object({
  work: FutureWork,
  already_dispatched_task_ids: z.array(z.uuid()),
});
export const FutureWorkMutationResult = MutationResult;
export const FutureWorkListResult = z.object({
  items: z.array(FutureWork),
  next_cursor: z.string().nullable(),
});
export const ListRequest = FutureWorkListInput.extend({ run_id: z.uuid() });
export const UpdateRequest = FutureWorkUpdateInput.extend({
  run_id: z.uuid(),
  client_action_id: z.uuid(),
});
export const CancelRequest = FutureWorkCancelInput.extend({
  run_id: z.uuid(),
  client_action_id: z.uuid(),
});
