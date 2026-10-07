import { z } from "zod";
import { PushConfig } from "./schema.ts";

export const FcmConfig = z.object({
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  client_email: z.email(),
  private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
  encryptionKey: PushConfig.shape.encryptionKey,
});
export type FcmConfig = z.infer<typeof FcmConfig>;
export type NotificationConfig = {
  readonly web?: PushConfig;
  readonly fcm?: FcmConfig;
};
export function notificationConfig(env: Readonly<Record<string, string | undefined>> | {
  readonly VAPID_SUBJECT?: string | undefined;
  readonly VAPID_PUBLIC_KEY?: string | undefined;
  readonly VAPID_PRIVATE_KEY?: string | undefined;
  readonly EXTENSION_ENCRYPTION_KEY?: string | undefined;
  readonly FCM_SERVICE_ACCOUNT_JSON?: string | undefined;
}): NotificationConfig {
  const web = PushConfig.safeParse({
    subject: env["VAPID_SUBJECT"],
    publicKey: env["VAPID_PUBLIC_KEY"],
    privateKey: env["VAPID_PRIVATE_KEY"],
    encryptionKey: env["EXTENSION_ENCRYPTION_KEY"],
  });
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(env["FCM_SERVICE_ACCOUNT_JSON"] ?? "null");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const account = z
    .object({ project_id: z.string(), client_email: z.string(), private_key: z.string() })
    .safeParse(serviceAccount);
  const fcm = FcmConfig.safeParse({
    ...(account.success ? account.data : {}),
    encryptionKey: env["EXTENSION_ENCRYPTION_KEY"],
  });
  return { ...(web.success ? { web: web.data } : {}), ...(fcm.success ? { fcm: fcm.data } : {}) };
}
export function normalizeConfig(config: NotificationConfig | PushConfig): NotificationConfig {
  return "publicKey" in config ? { web: config } : config;
}
