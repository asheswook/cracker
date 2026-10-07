import { mkdir, writeFile } from "node:fs/promises";
import { hashToken } from "../services/control/auth";

const clientToken = `client_${crypto.randomUUID()}_${crypto.randomUUID()}`;
const vmToken = `vm_${crypto.randomUUID()}_${crypto.randomUUID()}`;
const provisionToken = `${crypto.randomUUID()}_${crypto.randomUUID()}`;
const workspaceId = crypto.randomUUID();
const vmId = crypto.randomUUID();
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(".local/remote-connection.json", JSON.stringify({ control_url: "http://127.0.0.1:8788", workspace_id: workspaceId, vm_id: vmId, client_token: clientToken, vm_token: vmToken }), { flag: "wx", mode: 0o600 });
await writeFile("infra/provision/.dev.vars", `PROVISION_TOKEN=${provisionToken}\n`, { flag: "wx", mode: 0o600 });
await writeFile(".local/provision-request.json", JSON.stringify({ workspace_id: workspaceId, vm_id: vmId, client_hash: await hashToken(clientToken), vm_hash: await hashToken(vmToken) }), { flag: "wx", mode: 0o600 });
console.log("Prepared protected remote setup files; no tokens printed.");
