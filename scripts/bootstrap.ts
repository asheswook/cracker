import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createDatabase } from "../services/control/db";
import { hashToken } from "../services/control/auth";

if (process.argv.includes("--help")) {
  console.log("DATABASE_URL=postgres://... bun scripts/bootstrap.ts\nCreates a workspace, VM and separate revocable credentials in .local/connection.json (0600). Refuses to replace an existing file.");
  process.exit(0);
}
const sql = createDatabase(z.string().url().parse(process.env["DATABASE_URL"]));
const clientToken = `client_${crypto.randomUUID()}_${crypto.randomUUID()}`;
const vmToken = `vm_${crypto.randomUUID()}_${crypto.randomUUID()}`;
const workspaceId = crypto.randomUUID();
const vmId = crypto.randomUUID();
await mkdir(".local", { recursive: true, mode: 0o700 });
const connection = { control_url: "http://127.0.0.1:8787", workspace_id: workspaceId, vm_id: vmId, client_token: clientToken, vm_token: vmToken };
await writeFile(".local/connection.json", JSON.stringify(connection, null, 2), { flag: "wx", mode: 0o600 });
try {
  await sql.begin(async tx => {
    await tx`INSERT INTO workspaces(id,name) VALUES(${workspaceId},'Personal')`;
    await tx`INSERT INTO vms(id,workspace_id,name) VALUES(${vmId},${workspaceId},'Assistant computer')`;
    await tx`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(clientToken)},${workspaceId},'client',NULL),(${await hashToken(vmToken)},${workspaceId},'vm',${vmId})`;
  });
  console.log("Created workspace and credentials. Open .local/connection.json locally; do not share its contents.");
} finally {
  await sql.end();
}
