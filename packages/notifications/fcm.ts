import ky from "ky";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { FcmConfig } from "./config.ts";
import type { NativeSubscription } from "./schema.ts";

export class FcmSendError extends Error {
  constructor(
    readonly code:
      | "fcm_auth_failed"
      | "fcm_config_invalid"
      | "fcm_transport_failed"
      | "fcm_rate_limited"
      | "fcm_unavailable"
      | "notification_expired",
  ) {
    super(code);
    this.name = "FcmSendError";
  }
}
const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const errorResponse = z.object({
  error: z.object({
    details: z
      .array(
        z.object({
          "@type": z.string(),
          errorCode: z.string().optional(),
        }),
      )
      .optional(),
  }),
});
// A single cache entry bounds isolate memory; matching credentials prevents reuse after key rotation.
let cached:
  | { readonly identity: string; readonly token: string; readonly expires: number }
  | undefined;
let pending: { readonly identity: string; readonly promise: Promise<string> } | undefined;
async function accessToken(config: FcmConfig): Promise<string> {
  const identity = `${config.client_email}:${config.private_key}`;
  if (cached?.identity === identity && cached.expires > Date.now() + 60000) return cached.token;
  if (pending?.identity === identity) return pending.promise;
  const promise = (async () => {
    let assertion: string;
    try {
      const key = await importPKCS8(config.private_key, "RS256");
      assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(config.client_email)
        .setAudience("https://oauth2.googleapis.com/token")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(key);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new FcmSendError("fcm_config_invalid");
    }
    const response = await ky.post("https://oauth2.googleapis.com/token", {
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      timeout: 8000,
      retry: 0,
      redirect: "manual",
      throwHttpErrors: false,
    });
    if (!response.ok)
      throw new FcmSendError(
        response.status === 429
          ? "fcm_rate_limited"
          : response.status >= 500
            ? "fcm_unavailable"
            : "fcm_auth_failed",
      );
    const parsed = tokenResponse.safeParse(await response.json());
    if (!parsed.success) throw new FcmSendError("fcm_auth_failed");
    cached = {
      identity,
      token: parsed.data.access_token,
      expires: Date.now() + Math.min(parsed.data.expires_in, 3600) * 1000,
    };
    return cached.token;
  })();
  pending = { identity, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = undefined;
  }
}
const Message = z.object({ id: z.uuid(), title: z.string(), body: z.string(), url: z.string() });
export async function sendFcm(
  subscription: NativeSubscription,
  config: FcmConfig,
  message: { readonly data: string; readonly expiresAt: number; readonly topic: string },
) {
  try {
    if (message.expiresAt - Date.now() < 1000) throw new FcmSendError("notification_expired");
    const token = await accessToken(config);
    const data = Message.parse(JSON.parse(message.data));
    if (message.expiresAt - Date.now() < 1000) throw new FcmSendError("notification_expired");
    const response = await ky.post(
      `https://fcm.googleapis.com/v1/projects/${config.project_id}/messages:send`,
      {
        headers: { authorization: `Bearer ${token}` },
        json: {
          message: {
            token: subscription.token,
            notification: { title: data.title, body: data.body },
            data: { url: data.url, id: data.id },
            apns: {
              headers: {
                "apns-priority": "10",
                "apns-push-type": "alert",
                "apns-expiration": String(Math.floor(message.expiresAt / 1000)),
                "apns-collapse-id": message.topic,
              },
              payload: { aps: { sound: "default" } },
            },
          },
        },
        timeout: 10000,
        retry: 0,
        redirect: "manual",
        throwHttpErrors: false,
      },
    );
    if (response.status === 401) cached = undefined;
    let unregistered = false;
    if (response.status === 404) {
      const parsed = errorResponse.safeParse(
        await response.json().catch((error: unknown) => {
          if (!(error instanceof SyntaxError)) throw error;
          return null;
        }),
      );
      unregistered =
        parsed.success &&
        !!parsed.data.error.details?.some(
          (detail) =>
            detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
            detail.errorCode === "UNREGISTERED",
        );
    }
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      unregistered,
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof FcmSendError) throw error;
    throw new FcmSendError("fcm_transport_failed");
  }
}
