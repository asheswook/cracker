import { z } from "zod";
import type { Principal } from "../../services/control/auth.ts";
import type { Transaction } from "../../services/control/db.ts";
import { nextDailyAt } from "../memory/daily-work.ts";
import { DomainError } from "../protocol/index.ts";
import { records } from "./records.ts";
import type { FutureWork } from "./schema.ts";
import type { Mutation } from "./store.ts";

export async function applyMutation(
  tx: Transaction,
  context: { readonly principal: Principal; readonly current: z.infer<typeof FutureWork> },
  mutation: Mutation,
) {
  const { current, principal } = context;
  const workspace = principal.workspace_id;
  let supersedesPending = mutation.kind === "cancel";
  if (mutation.kind === "cancel") {
    if (current.kind === "schedule")
      await tx`UPDATE assistant.schedules SET status='cancelled',management_revision=management_revision+1 WHERE id=${current.id}`;
    else await tx`UPDATE assistant.responsibilities SET state='cancelled',management_revision=management_revision+1 WHERE id=${current.id}`;
  } else {
    const work = mutation.body.work;
    if (work.kind === "schedule") {
      const config = work.configuration;
      try {
        new Intl.DateTimeFormat("en", { timeZone: config.timezone });
      } catch (error) {
        if (error instanceof RangeError)
          throw new DomainError("invalid_timezone", "Invalid timezone", 400);
        throw error;
      }
      await tx`UPDATE assistant.schedules SET title=${config.title},objective=${config.objective},due_at=${config.due_at},timezone=${config.timezone},management_revision=management_revision+1 WHERE id=${current.id}`;
    } else {
      const config = work.configuration;
      if (config.until_at !== null && config.trigger.kind !== "daily" && config.trigger.kind !== "periodic") throw new DomainError("invalid_until", "Only daily/periodic routines accept end dates", 400);
      const expired = config.until_at !== null && new Date(config.until_at).getTime() <= Date.now();
      const previous = current.kind === "responsibility" ? current.configuration.trigger : null;
      const changed = JSON.stringify(previous) !== JSON.stringify(config.trigger);
      supersedesPending = expired || changed || current.configuration.objective !== config.objective;
      if (
        config.trigger.kind === "task_change" &&
        !(
          await tx`SELECT id FROM assistant.tasks WHERE id=${config.trigger.task_id} AND workspace_id=${workspace} AND conversation_id=${current.conversation_id}`
        )[0]
      )
        throw new DomainError("not_found", "Trigger task not found in target conversation", 404);
      let due = current.next_due_at;
      if (changed) {
        const trigger = config.trigger;
        switch (trigger.kind) {
          case "deadline":
            due = trigger.due_at;
            break;
          case "daily":
            due = await nextDailyAt(tx, trigger, new Date().toISOString());
            break;
          case "periodic":
          case "task_change":
            due = new Date().toISOString();
            break;
          default: {
            const exhaustive: never = trigger;
            throw new TypeError(String(exhaustive));
          }
        }
      }
      await tx`UPDATE assistant.responsibilities SET until_at=${config.until_at},state=${expired ? "complete" : current.state},title=${config.title},objective=${config.objective},trigger=${JSON.stringify(config.trigger)}::text::jsonb,notification_mode=${config.notification_mode},quiet_hours=${config.quiet_hours ? JSON.stringify(config.quiet_hours) : null}::text::jsonb,next_review_at=${due},management_revision=management_revision+1,failure_count=0,last_error=NULL WHERE id=${current.id}`;
    }
  }
  let dispatched: { task_id: string }[] = [];
  if (current.kind === "responsibility") {
    if(supersedesPending){
      await tx`UPDATE assistant.responsibility_actions SET state='cancelled' WHERE responsibility_id=${current.id} AND state='pending'`;
      await tx`UPDATE assistant.responsibility_notifications SET state='cancelled' WHERE responsibility_id=${current.id} AND state='pending'`;
    }
    dispatched = z
      .array(z.object({ task_id: z.uuid() }))
      .parse(
        await tx`SELECT a.task_id FROM assistant.responsibility_actions a JOIN assistant.tasks t ON t.id=a.task_id WHERE a.responsibility_id=${current.id} AND a.state='dispatched' AND t.state NOT IN ('cancelled','succeeded','failed')`,
      );
  }
  const updated = (await records(tx, principal, current))[0];
  if (!updated) throw new DomainError("not_found", "Future work disappeared during mutation", 409);
  return { work: updated, already_dispatched_task_ids: dispatched.map((row) => row.task_id) };
}
