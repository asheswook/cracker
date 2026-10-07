import { z } from "zod";
import { Server, type McpConfig } from "./schema.ts";
import { unseal } from "./secrets.ts";

const URL_KEY = "$mcp_url";
export function headerSecrets(secrets: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== URL_KEY));
}
export function storedConfiguration(config: McpConfig, secrets: Readonly<Record<string, string>>) {
  const values = headerSecrets(secrets);
  if (config.transport !== "http") return { config, secrets: values };
  const url = new URL(config.url);
  if (!url.username && !url.password && !url.search && !url.hash) return { config, secrets: values };
  values[URL_KEY] = config.url;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { config: { transport: "http" as const, url: url.href }, secrets: values };
}
export async function restoredServer(row: unknown, key: string | undefined) {
  const server = Server.parse(row);
  const { secret_cipher } = z.object({ secret_cipher: z.string().nullable() }).parse(row);
  const values = await unseal(secret_cipher, key);
  const url = values[URL_KEY];
  return {
    server: server.config.transport === "http" && url
      ? { ...server, config: { transport: "http" as const, url } }
      : server,
    secrets: headerSecrets(values),
  };
}
