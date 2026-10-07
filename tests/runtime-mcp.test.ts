import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ToolExecutor } from "../services/daemon/tools.ts";

test("HTTP MCP executes and refreshes while an unavailable legacy sibling stays isolated", async () => {
  // Given an actual MCP server on an ephemeral HTTP port.
  const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
  mcp.registerTool("add", { inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  await mcp.connect(transport);
  const server = Bun.serve({ port: 0, fetch: request => transport.handleRequest(request) });
  const dir = await mkdtemp(join(tmpdir(), "mcp-http-")), config = join(dir, "mcp.json");
  await Bun.write(config, JSON.stringify([{ transport: "http", name: "fixture", url: server.url.href, headers: {} }, { transport: "stdio", name: "unavailable", command: "/nonexistent-mcp-legacy-731", args: [] }]));
  const tools = new ToolExecutor(); await tools.connect(config);
  try {
    const addition = tools.definitions.find(t => t.type === "function" && t.name.includes("_add_"));
    if (!addition || addition.type !== "function") throw new TypeError("missing fixture tool");
    // When
    const result = await tools.run(addition.name, JSON.stringify({ a: 19, b: 23 }), AbortSignal.timeout(5000));
    mcp.registerTool("multiply", { inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a * b) }] }));
    await tools.refreshAll();
    // Then
    expect(z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) }).parse(JSON.parse(result.text)).content).toEqual([{ type: "text", text: "42" }]);
    expect(tools.definitions.some(t => t.type === "function" && t.name.includes("_multiply_"))).toBe(true);
  } finally { await tools.close(); await mcp.close(); await server.stop(true); await rm(dir, { recursive: true }); }
});

test('HTTP MCP carries encoded userinfo as Basic auth and query intact; tool echoes redact URL secrets',async()=>{
 const mcp=new McpServer({name:'URL fixture',version:'1'}),seen:{authorization:string|null;query:string|null}[]=[];
 const user='url-user',password='p@ss:word',query='synthetic-query-secret';
 const basic=`Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
 mcp.registerTool('url_echo',{inputSchema:{}},async()=>({content:[{type:'text',text:`${user} ${password} ${query} ${basic}`}]}));
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),enableJsonResponse:true});await mcp.connect(transport);
 const server=Bun.serve({port:0,fetch:request=>{const url=new URL(request.url);seen.push({authorization:request.headers.get('authorization'),query:url.searchParams.get('key')});if(request.headers.get('authorization')!==basic||url.searchParams.get('key')!==query)return new Response('unauthorized',{status:401});return transport.handleRequest(request)}});
 const url=new URL('/mcp',server.url);url.username=user;url.password=password;url.searchParams.set('key',query);
 const tools=new ToolExecutor();
 try{await tools.addMcp('url_fixture',{transport:'http',url:url.href},{});const tool=tools.definitions.find(t=>t.type==='function'&&t.name.includes('url_echo'));if(!tool||tool.type!=='function')throw new TypeError('missing URL fixture tool');
 const result=await tools.run(tool.name,'{}',AbortSignal.timeout(5000));expect(seen.length).toBeGreaterThan(0);expect(seen.every(r=>r.authorization===basic&&r.query===query)).toBe(true);expect(result.text).toContain(user);for(const secret of [password,query,basic])expect(result.text).not.toContain(secret);expect(result.text).toContain('[REDACTED]');
 }finally{await tools.close();await mcp.close();await server.stop(true)}
});

test('explicit Authorization header wins over URL userinfo',async()=>{
 const {mcpHttpTarget}=await import('../services/daemon/mcp-url.ts');
 const target=mcpHttpTarget(new URL('https://a:b@example.com/mcp?token=unchanged'),{authorization:'Bearer explicit'});
 expect(target.headers.get('authorization')).toBe('Bearer explicit');expect(target.url.href).toBe('https://example.com/mcp?token=unchanged');
});

test('ordinary short MCP query values do not rewrite tool descriptions, schema, or results',async()=>{
 const mcp=new McpServer({name:'ordinary query',version:'1'});
 mcp.registerTool('add',{description:'a1 arithmetic',inputSchema:{a:z.enum(['a','1'])}},async({a})=>({content:[{type:'text',text:`a1:${a}`}]}));
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),enableJsonResponse:true});await mcp.connect(transport);
 const endpoint=Bun.serve({port:0,fetch:request=>transport.handleRequest(request)});
 const tools=new ToolExecutor();
 try{await tools.addMcp('ordinary',{transport:'http',url:new URL('/mcp?page=1&q=a',endpoint.url).href},{});
 const tool=tools.definitions.find(t=>t.type==='function'&&t.name.includes('_add_'));if(!tool||tool.type!=='function')throw new TypeError('ordinary query tool absent');
 expect(tool.description).toBe('a1 arithmetic');expect(z.object({properties:z.object({a:z.object({enum:z.array(z.string())})})}).parse(tool.parameters).properties.a.enum.sort()).toEqual(['1','a']);
 expect((await tools.run(tool.name,JSON.stringify({a:'a'}),AbortSignal.timeout(5000))).text).toContain('a1:a');
 }finally{await tools.close();await mcp.close();await endpoint.stop(true)}
});

test('short userinfo and credential query do not corrupt actual MCP schemas or calls',async()=>{
 const mcp=new McpServer({name:'short userinfo',version:'1'});
 const auth=`Basic ${Buffer.from('u:p').toString('base64')}`;
 let completeUrl='';
 mcp.registerTool('multiply',{description:'public input processing',inputSchema:{input:z.enum(['up','public'])}},async({input})=>({content:[{type:'text',text:JSON.stringify({input,proof:'public',authorization:auth,url:completeUrl})}]}));
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),enableJsonResponse:true});await mcp.connect(transport);
 const endpoint=Bun.serve({port:0,fetch:request=>request.headers.get('authorization')===auth&&new URL(request.url).searchParams.get('key')==='x'?transport.handleRequest(request):new Response('unauthorized',{status:401})});
 const url=new URL('/mcp?key=x',endpoint.url);url.username='u';url.password='p';completeUrl=url.href;
 const tools=new ToolExecutor();
 try{await tools.addMcp('short',{transport:'http',url:completeUrl},{});const tool=tools.definitions.find(t=>t.type==='function'&&t.name.includes('_multiply_'));if(!tool||tool.type!=='function')throw new TypeError('short userinfo corrupted tool name');
 expect(tool.description).toBe('public input processing');expect(z.object({properties:z.object({input:z.object({enum:z.array(z.string())})})}).parse(tool.parameters).properties.input.enum.sort()).toEqual(['public','up']);
 const result=await tools.run(tool.name,JSON.stringify({input:'up'}),AbortSignal.timeout(5000));expect(result.text).toContain('public');expect(result.text).toContain('up');expect(result.text).not.toContain(auth);expect(result.text).not.toContain(completeUrl);expect(result.text).toContain('[REDACTED]');
 }finally{await tools.close();await mcp.close();await endpoint.stop(true)}
});
