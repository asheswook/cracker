import { z } from "zod";
export const PushConfig = z.object({
  subject: z
    .string()
    .refine((value) => value.startsWith("mailto:") || value.startsWith("https://")),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  encryptionKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export type PushConfig = z.infer<typeof PushConfig>;
export const PushSubscription = z
  .object({
    endpoint: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value),
          host = url.hostname;
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (!url.port || url.port === "443") &&
          (host === "fcm.googleapis.com" ||
            host.endsWith(".push.apple.com") ||
            host.endsWith(".push.services.mozilla.com") ||
            host.endsWith(".notify.windows.com"))
        );
      }, "Unsupported push service"),
    expirationTime: z.number().nonnegative().nullable().default(null),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      })
      .strict(),
  })
  .strict();
export type PushSubscription = z.infer<typeof PushSubscription>;
export const NativeSubscription = z
  .object({
    transport: z.literal("fcm"),
    platform: z.enum(["ios", "macos"]),
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_:.-]+$/),
  })
  .strict();
export type NativeSubscription = z.infer<typeof NativeSubscription>;
export const Subscription = z.union([PushSubscription, NativeSubscription]);
export const Registration = z
  .object({ installation_id: z.uuid(), subscription: Subscription })
  .strict();

export const Viewing = z.object({
  installation_id: z.uuid(),
  conversation_id: z.uuid().optional(),
  page_id: z.uuid(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  active: z.boolean(),
  observed_at: z.number().int().nonnegative().max(8640000000000000),
}).strict();
