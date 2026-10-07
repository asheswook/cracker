import { z } from "zod";

export class PostgresToolError extends Error {
  constructor(
    readonly tool: string,
    readonly exitCode: number,
  ) {
    super(`${tool} failed (exit ${exitCode}); connection details omitted`);
  }
}

export function databaseUrl(): URL {
  const url = new URL(z.url().parse(process.env["DATABASE_URL"]));
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new TypeError("DATABASE_URL must use PostgreSQL");
  }
  return url;
}

export async function postgresTool(command: readonly string[], url: URL): Promise<void> {
  const [tool] = command;
  if (!tool) throw new TypeError("PostgreSQL tool required");
  const env: Record<string, string | undefined> = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "15",
  };
  for (const [key, value] of url.searchParams) {
    switch (key) {
      case "sslmode":
        env["PGSSLMODE"] = value;
        break;
      case "sslrootcert":
        env["PGSSLROOTCERT"] = value;
        break;
      default:
        throw new TypeError(`Unsupported database option: ${key}`);
    }
  }
  const child = Bun.spawn([...command], { env, stdout: "ignore", stderr: "ignore" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new PostgresToolError(tool, exitCode);
}
