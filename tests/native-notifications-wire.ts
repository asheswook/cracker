import { expect } from "bun:test";
import { jwtVerify } from "jose";
import { z } from "zod";
import { config, keys } from "./native-notifications-fixture.ts";
export function createWire() {
  const state: {
    messages: { token: string; notification: { title: string; body: string }; data: { id: string; url: string } }[];
    oauthCalls: number;
    status: number;
    errorCode: string;
    onSend: (() => Promise<void>) | undefined;
  } = { messages: [], oauthCalls: 0, status: 200, errorCode: "UNREGISTERED", onSend: undefined };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname === "/token") {
        state.oauthCalls++;
        const assertion = (await request.formData()).get("assertion");
        if (typeof assertion !== "string") return new Response(null, { status: 400 });
        const verified = await jwtVerify(assertion, keys.publicKey, {
          issuer: config.client_email,
          audience: "https://oauth2.googleapis.com/token",
        });
        expect(verified.payload["scope"]).toBe(
          "https://www.googleapis.com/auth/firebase.messaging",
        );
        return Response.json({ access_token: "synthetic-access-token", expires_in: 3600 });
      }
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-access-token");
      const body = z
        .object({
          message: z.object({
            token: z.string(),
            notification: z.object({ title: z.string(), body: z.string() }),
            data: z.object({ id: z.uuid(), url: z.string() }),
            apns: z.object({ headers: z.record(z.string(), z.string()) }),
          }),
        })
        .parse(await request.json());
      expect(body.message.apns.headers["apns-push-type"]).toBe("alert");
      state.messages.push(body.message);
      await state.onSend?.();
      return state.status === 200
        ? Response.json({ name: "projects/test-native-project/messages/accepted" })
        : Response.json(
            {
              error: {
                details: [
                  {
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    errorCode: state.errorCode,
                  },
                ],
              },
            },
            { status: state.status, headers: { "retry-after": "120" } },
          );
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      if (url.hostname === "oauth2.googleapis.com" || url.hostname === "fcm.googleapis.com")
        return original(new Request(new URL(url.pathname, server.url), request));
      return original(request);
    },
    { preconnect: original.preconnect },
  );
  return Object.assign(state, {
    async close() {
      globalThis.fetch = original;
      await server.stop();
    },
  });
}
