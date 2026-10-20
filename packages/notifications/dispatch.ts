import ky, { TimeoutError } from "ky";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { z } from "zod";
import type { Database } from "../../services/control/db.ts";
import { unseal } from "../extensions/secrets.ts";
import { NativeSubscription, PushSubscription, type PushConfig } from "./schema.ts";
import { Delivery } from "./store.ts";
import { notificationPresentation } from "./presentation.ts";
import { normalizeConfig, type NotificationConfig } from "./config.ts";
import { sendFcm, FcmSendError } from "./fcm.ts";
type PushSender = (
  subscription: PushSubscription,
  config: PushConfig,
  message: { readonly data: string; readonly expiresAt: number; readonly topic: string },
) => Promise<{ readonly status: number; readonly retryAfter: string | null }>;
export class PushSendError extends Error {
  constructor(
    readonly code:
      | "payload_build_failed"
      | "push_timeout"
      | "notification_expired"
      | "push_transport_type_error"
      | "push_transport_failed",
  ) {
    super(code);
    this.name = "PushSendError";
  }
}
export const sendPush: PushSender = async (subscription, config, message) => {
  if (message.expiresAt - Date.now() < 1000) throw new PushSendError("notification_expired");
  const payload = await buildPushPayload(
    { data: message.data, options: { topic: message.topic, urgency: "normal" } },
    subscription,
    { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
  ).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    throw new PushSendError("payload_build_failed");
  });
  const ttl = Math.floor((message.expiresAt - Date.now()) / 1000);
  if (ttl <= 0) throw new PushSendError("notification_expired");
  try {
    const response = await ky(subscription.endpoint, {
      ...payload,
      headers: { ...payload.headers, ttl: String(ttl) },
      // Workers supports manual/follow only. Never forward a subscription or VAPID to a redirect.
      redirect: "manual",
      retry: 0,
      timeout: 10000,
      throwHttpErrors: false,
    });
    return { status: response.status, retryAfter: response.headers.get("retry-after") };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new PushSendError(
      error instanceof TimeoutError
        ? "push_timeout"
        : error instanceof TypeError
          ? "push_transport_type_error"
          : "push_transport_failed",
    );
  }
};
export async function dispatchNotifications(
  sql: Database,
  input: PushConfig | NotificationConfig,
  send: PushSender = sendPush,
): Promise<number> {
  const config = normalizeConfig(input);
  const transports = [...(config.web ? ["web"] : []), ...(config.fcm ? ["fcm"] : [])];
  await sql`UPDATE assistant.notification_deliveries d SET state='expired',lease_id=NULL,lease_until=NULL FROM assistant.notification_intents n WHERE n.id=d.intent_id AND n.expires_at<=now() AND d.state IN ('pending','leased')`;
  await sql`UPDATE assistant.notification_deliveries d SET state='suppressed',lease_id=NULL,lease_until=NULL WHERE d.state IN ('pending','leased') AND NOT EXISTS(
 SELECT 1 FROM assistant.push_subscriptions s JOIN assistant.credentials c ON c.token_hash=s.credential_hash
 WHERE s.id=d.subscription_id AND s.enabled AND c.revoked_at IS NULL)`;
  const jobs = await sql.begin(async (tx) => {
    const rows = z.array(Delivery.omit({ lease_id: true })).parse(
      await tx`SELECT d.id,d.intent_id,d.subscription_id,s.subscription_cipher,s.transport,n.conversation_id,n.message_id,n.expires_at,d.attempts FROM assistant.notification_deliveries d JOIN assistant.notification_intents n ON n.id=d.intent_id JOIN assistant.push_subscriptions s ON s.id=d.subscription_id
   WHERE n.outcome='message' AND s.transport=ANY(${transports}) AND n.expires_at>now() AND ((d.state='pending' AND d.next_attempt_at<=now()) OR (d.state='leased' AND d.lease_until<now())) ORDER BY d.next_attempt_at,d.id LIMIT 10 FOR UPDATE OF d SKIP LOCKED`,
    );
    const leased = [];
    for (const row of rows) {
      const lease_id = crypto.randomUUID();
      await tx`UPDATE assistant.notification_deliveries SET state='leased',lease_id=${lease_id},lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=${row.id}`;
      leased.push({ ...row, attempts: row.attempts + 1, lease_id });
    }
    return leased;
  });
  await Promise.all(
    jobs.map(async (job) => {
      let state = "failed",
        code: string | null = null,
        retrySeconds = 0;
      let stage: "subscription" | "send" = "subscription";
      try {
        const allowed =
          await sql`SELECT d.id FROM assistant.notification_deliveries d JOIN assistant.push_subscriptions s ON s.id=d.subscription_id JOIN assistant.credentials c ON c.token_hash=s.credential_hash WHERE d.id=${job.id} AND d.state='leased' AND d.lease_id=${job.lease_id} AND s.subscription_cipher=${job.subscription_cipher} AND s.enabled AND c.revoked_at IS NULL`;
        if (!allowed.length) return;
        const selected = config[job.transport];
        if (!selected) return;
        const plain = await unseal(job.subscription_cipher, selected.encryptionKey);
        const url = `/?conversation=${job.conversation_id}&message=${job.message_id}`;
        const source = z.object({ persona_name: z.string(), notification_show_content: z.boolean(), content: z.string(), attachment_names: z.array(z.string()) }).parse(
          (await sql`SELECT w.persona_name,w.notification_show_content,m.content,ARRAY(SELECT a.name FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=m.id ORDER BY ma.position) AS attachment_names FROM assistant.messages m JOIN assistant.workspaces w ON w.id=m.workspace_id WHERE m.id=${job.message_id}`)[0],
        );
        const suppressed = await sql`UPDATE assistant.notification_deliveries d
            SET state='suppressed',last_error='viewing_app',lease_id=NULL,lease_until=NULL
            WHERE d.id=${job.id} AND d.state='leased' AND d.lease_id=${job.lease_id}
              AND (EXISTS(SELECT 1 FROM assistant.notification_conversation_viewing v
                JOIN assistant.notification_intents n ON n.id=d.intent_id AND n.workspace_id=v.workspace_id AND n.conversation_id=v.conversation_id
                JOIN assistant.credentials c ON c.token_hash=v.credential_hash AND c.workspace_id=v.workspace_id
                LEFT JOIN assistant.browser_sessions b ON b.token_hash=v.session_hash
                WHERE v.expires_at>clock_timestamp() AND c.revoked_at IS NULL
                  AND (v.session_hash IS NULL OR (b.revoked_at IS NULL AND b.expires_at>clock_timestamp())))
              OR (${job.transport}='web' AND EXISTS(SELECT 1 FROM assistant.notification_viewing v WHERE v.subscription_id=d.subscription_id AND v.expires_at>clock_timestamp()))) RETURNING d.id`;
        if (suppressed.length) return;
        stage = "send";
        const expiresAt = Date.parse(job.expires_at);
        if (expiresAt - Date.now() < 1000) throw new PushSendError("notification_expired");
        const message = {
          expiresAt,
          topic: job.intent_id.replaceAll("-", ""),
          data: JSON.stringify({
            id: job.intent_id,
            ...notificationPresentation(source),
            url,
          }),
        };
        const response =
          job.transport === "fcm" && config.fcm
            ? await sendFcm(
                NativeSubscription.parse(JSON.parse(plain["subscription"] ?? "null")),
                config.fcm,
                message,
              )
            : config.web
              ? await send(
                  PushSubscription.parse(JSON.parse(plain["subscription"] ?? "null")),
                  config.web,
                  message,
                )
              : null;
        if (!response) return;
        if (response.status >= 200 && response.status < 300) state = "accepted";
        else if (
          job.transport === "fcm"
            ? "unregistered" in response && response.unregistered
            : response.status === 404 || response.status === 410
        ) {
          state = "invalid";
          code = job.transport === "fcm" ? "fcm_unregistered" : "subscription_expired";
          await sql`UPDATE assistant.push_subscriptions SET enabled=false,updated_at=now() WHERE id=${job.subscription_id} AND subscription_cipher=${job.subscription_cipher}`;
        } else if (response.status === 429 || response.status >= 500) {
          state = "pending";
          code =
            job.transport === "fcm"
              ? response.status === 429
                ? "fcm_rate_limited"
                : "fcm_unavailable"
              : "push_unavailable";
          const delay = response.retryAfter === null ? NaN : Number(response.retryAfter);
          retrySeconds = Number.isFinite(delay)
            ? delay
            : response.retryAfter
              ? Math.ceil((Date.parse(response.retryAfter) - Date.now()) / 1000)
              : 0;
        } else if (job.transport === "fcm") {
          state = "pending";
          code =
            response.status === 401 || response.status === 403
              ? "fcm_auth_failed"
              : "fcm_request_rejected";
        } else
          code =
            response.status >= 300 && response.status < 400
              ? "push_redirect_rejected"
              : "push_rejected";
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        state = "pending";
        code =
          error instanceof PushSendError || error instanceof FcmSendError
            ? error.code
            : stage === "subscription"
              ? "subscription_decode_failed"
              : "push_transport_failed";
        if (code === "notification_expired") state = "expired";
      }
      if (state === "pending" && job.attempts >= 5) {
        state = "failed";
        code = `retry_exhausted:${code}`;
      }
      retrySeconds = Math.max(
        30,
        Math.min(3600, retrySeconds || 30 * 2 ** job.attempts + Math.floor(Math.random() * 10)),
      );
      await sql`UPDATE assistant.notification_deliveries SET state=${state},last_error=${code},next_attempt_at=now()+${retrySeconds}*interval '1 second',accepted_at=CASE WHEN ${state}='accepted' THEN now() ELSE accepted_at END,lease_id=NULL,lease_until=NULL WHERE id=${job.id} AND state='leased' AND lease_id=${job.lease_id}`;
    }),
  );
  return jobs.length;
}
