import { z } from "zod";
import type { Query } from "../../services/control/db.ts";
import type { Trigger } from "./responsibility-schema.ts";

type Daily = Extract<z.infer<typeof Trigger>, {kind:"daily"}>;
export async function nextDailyAt(sql: Query, trigger: Daily, after: string): Promise<string> {
  const row = z.object({next:z.string()}).parse((await sql`
    WITH local AS (SELECT ${after}::timestamptz AT TIME ZONE ${trigger.timezone} AS clock),
    candidate AS (SELECT date_trunc('day',clock)+make_interval(hours=>${trigger.hour},mins=>${trigger.minute}) AS wall FROM local)
    SELECT CASE WHEN wall AT TIME ZONE ${trigger.timezone}>=${after}::timestamptz
      THEN wall AT TIME ZONE ${trigger.timezone}
      ELSE (wall+interval '1 day') AT TIME ZONE ${trigger.timezone} END AS next FROM candidate
  `)[0]);
  return row.next;
}

export async function enqueueDaily(sql: Query, row: {
  readonly id:string;readonly workspace_id:string;readonly objective:string;
  readonly trigger:Daily;readonly next_review_at:string;
}):Promise<void>{
  const occurrence=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([row.id,row.next_review_at])));
  const key=Array.from(new Uint8Array(occurrence),b=>b.toString(16).padStart(2,"0")).join("");
  await sql`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective,scheduled_for) VALUES(${row.workspace_id},${row.id},${key},${row.objective},${row.next_review_at}) ON CONFLICT DO NOTHING`;
  const next=await nextDailyAt(sql,row.trigger,new Date().toISOString());
  await sql`UPDATE assistant.responsibilities SET next_review_at=${next},last_evaluated_at=now(),failure_count=0,last_error=NULL WHERE id=${row.id}`;
}
