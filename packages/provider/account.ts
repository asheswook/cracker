import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { atomicSecret, Credential } from "./credentials.ts";
import { withCredentialLock } from "./credential-lock.ts";

const Registration = Credential.pick({ issuer: true, subject: true, client_id: true, ext_agent_host_id: true });
export function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function readRegistration(path: string): Promise<z.infer<typeof Registration> | undefined> {
  try { return Registration.parse(JSON.parse(await readFile(`${path}.registration`, "utf8"))); }
  catch (error) { if (!missingFile(error)) throw error; return undefined; }
}
export async function saveRegistration(path: string, credential: z.infer<typeof Registration>): Promise<void> {
  await atomicSecret(`${path}.registration`, Registration.parse(credential));
}
export async function disconnectAccount(path: string, request: typeof fetch = fetch): Promise<{ revoked: boolean }> {
  try {
    return await withCredentialLock(path, async () => {
      const credential = Credential.parse(JSON.parse(await readFile(path, "utf8")));
      await saveRegistration(path, credential);
      let revoked = false;
      try {
        const signal = AbortSignal.timeout(15000);
        const discovery = await request("https://auth.openai.com/.well-known/openid-configuration", { signal });
        if (!discovery.ok) throw new Error("discovery_failed");
        const metadata = z.object({ revocation_endpoint: z.url() }).parse(await discovery.json());
        const endpoint = new URL(metadata.revocation_endpoint);
        if (endpoint.origin !== "https://auth.openai.com") throw new Error("invalid_revocation_endpoint");
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await request(endpoint, { method: "POST", signal, body: new URLSearchParams({ token: credential.refresh_token, token_type_hint: "refresh_token", client_id: credential.client_id }) });
            if (result.ok) { revoked = true; break; }
            if (result.status < 500) break;
          } catch (error) { if (!(error instanceof Error)) throw error; if (signal.aborted) break; }
          if (attempt < 2) await Bun.sleep(250 * (attempt + 1));
        }
      } catch (error) { if (!(error instanceof Error)) throw error; }
      await unlink(path);
      return { revoked };
    });
  } catch (error) { if (!missingFile(error)) throw error; return { revoked: true }; }
}
