import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browserServer } from "./browser-mcp";

const bridge = await browserServer(process.argv[2]);
await bridge.server.connect(new StdioServerTransport());
