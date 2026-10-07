import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { z } from "zod";

class KeySetupError extends Error {
  constructor(readonly exitCode: number) {
    super(`Cloudflare secret configuration failed with exit code ${exitCode}`);
    this.name = "KeySetupError";
  }
}

const path = ".local/extensions-key";
if (process.argv.includes("--deploy")) {
  const listing = Bun.spawn(["pnpm", "exec", "wrangler", "secret", "list"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(listing.stdout).text();
  const code = await listing.exited;
  if (code !== 0) throw new KeySetupError(code);
  const secrets = z.array(z.object({ name: z.string() })).parse(JSON.parse(output));
  if (secrets.some((secret) => secret.name === "EXTENSION_ENCRYPTION_KEY")) {
    console.log(
      "Cloudflare encryption key already exists; left unchanged. Restore its protected backup for recovery; do not replace it while encrypted records exist.",
    );
    process.exit(0);
  }
}
await mkdir(".local", { recursive: true, mode: 0o700 });
try {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(randomBytes(32).toString("base64"));
  } finally {
    await file.close();
  }
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}
await chmod(path, 0o600);
const key = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .parse(await readFile(path, "utf8"));
if (process.argv.includes("--deploy")) {
  const child = Bun.spawn(
    ["pnpm", "exec", "wrangler", "secret", "put", "EXTENSION_ENCRYPTION_KEY"],
    {
      stdin: new Blob([key]),
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const code = await child.exited;
  if (code !== 0) throw new KeySetupError(code);
  console.log("Extension encryption key configured in Cloudflare; protected local copy retained.");
} else {
  console.log("Protected extension encryption key ready; use --deploy to configure Cloudflare.");
}
