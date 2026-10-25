import { z } from "zod";
import type { Query } from "../../services/control/db.ts";
export async function enqueueMessageNotification(
  sql: Query,
  workspace: string,
  message: { readonly id: string; readonly runId?: string; readonly progress?: boolean },
): Promise<void> {
  // Progress ("확인해 볼게요") is for the open conversation, not the lock screen: only a reply, a card that needs the user,
  // or an explicit notify_user interrupts. The caller knows which kind it is storing.
  if (message.progress) return;
  const rows =
    await sql`INSERT INTO assistant.notification_intents(id,workspace_id,run_id,task_id,conversation_id,message_id,outcome)
    SELECT m.id,m.workspace_id,${message.runId ?? null},m.task_id,m.conversation_id,m.id,'message'
    FROM assistant.messages m WHERE m.id=${message.id} AND m.workspace_id=${workspace} AND m.role IN ('assistant','system')
    AND NOT m.hidden AND (m.origin='user' OR m.notify=true)
    AND EXISTS(SELECT 1 FROM assistant.push_subscriptions s WHERE s.workspace_id=${workspace} AND s.enabled)
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!rows.length) return;
  await sql`INSERT INTO assistant.notification_deliveries(intent_id,subscription_id)
    SELECT ${message.id},s.id FROM assistant.push_subscriptions s JOIN assistant.credentials c ON c.token_hash=s.credential_hash
    WHERE s.workspace_id=${workspace} AND s.enabled AND c.revoked_at IS NULL ON CONFLICT DO NOTHING`;
}
export const Delivery = z.object({
  id: z.uuid(),
  intent_id: z.uuid(),
  subscription_id: z.uuid(),
  subscription_cipher: z.string(),
  transport: z.enum(["web", "fcm"]),
  conversation_id: z.uuid(),
  message_id: z.uuid(),
  expires_at: z.string(),
  attempts: z.number().int(),
  lease_id: z.uuid(),
});
