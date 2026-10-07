import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server=new McpServer({name:"configured-extension-fixture",version:"1.0.0"});
const nonce=crypto.randomUUID();
server.registerTool("fixture_echo",{description:"Return the supplied harmless value for extension acceptance.",inputSchema:{value:z.string()}},async({value})=>({content:[{type:"text",text:JSON.stringify({value,proof:`${value}::${nonce}`,pid:process.pid,fixture_secret:process.env["FIXTURE_SECRET"]??null})}]}));
await server.connect(new StdioServerTransport());
