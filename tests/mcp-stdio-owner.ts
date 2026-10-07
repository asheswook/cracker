import { join } from "node:path";
import { ToolExecutor } from "../services/daemon/tools.ts";

const receipt = process.argv[2];
if (!receipt) throw new TypeError("owner requires receipt path");
const tools = new ToolExecutor();
await tools.addMcp("owned", { transport: "stdio", command: process.execPath, args: [join(import.meta.dir, "mcp-stdio-fixture.ts"), "server", receipt] }, {});
process.stdout.write("connected\n");
setInterval(() => {}, 1000);
