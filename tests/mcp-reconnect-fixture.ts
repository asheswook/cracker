import { createServer } from "node:http";
import { z } from "zod";
import { ToolExecutor } from "../services/daemon/tools.ts";
const Rpc = z.object({ id: z.union([z.string(),z.number()]).optional(), method: z.string(), params: z.object({ name:z.string().optional(), arguments:z.record(z.string(),z.unknown()).optional() }).passthrough().optional() });
export async function reconnectFixture(dropTransport = false) {
  let notify = false, paginate=false, listings=0;
  let initialized = 0, expired = 0, unauthorized = false, changed = false;
  const calls: {session:string;name:string}[] = [];
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const initializing = Promise.withResolvers<void>(), allowInitialize = Promise.withResolvers<void>();
  let holdInitialize = false;
  const http = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    if(request.method!=="POST")return new Response(null,{status:405});
    const rpc=Rpc.parse(await request.json());
    if(rpc.method==='initialize') {
      initialized++;
      if(initialized>1&&holdInitialize){initializing.resolve();await allowInitialize.promise;}
      if(unauthorized)return new Response('unauthorized',{status:401});
      return Response.json({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}},{headers:{'mcp-session-id':String(initialized)}});
    }
    if(rpc.id===undefined)return new Response(null,{status:202});
    const session=request.headers.get('mcp-session-id')??'';
    if(rpc.method==='tools/list'){listings++;if(paginate)return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:[],nextCursor:String(listings)}});}
    if(rpc.method==='tools/list')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:['read','write'].map(name=>({name,description:notify?'updated catalogue':'original catalogue',inputSchema:{type:'object',properties:{mode:{type:'string'}}},annotations:{readOnlyHint:name==='read'&&!changed}}))}});
    if(rpc.method==='ping')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{}});
    const name=rpc.params?.name??'';calls.push({session,name});
    if(rpc.params?.arguments?.['mode']==='hold'){held.resolve();await release.promise;}
    else if(Number(session)<=expired)return new Response('expired session',{status:404});
    const notice=notify?`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})}\n\n`:'';
    return new Response(`${notice}event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:`result:${session}`}]}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }});
  const proxy=dropTransport?createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request){if(!Buffer.isBuffer(chunk))throw new TypeError('invalid wire chunk');chunks.push(chunk);}
    const body=Buffer.concat(chunks);
    if(body.length&&Rpc.parse(JSON.parse(body.toString())).method==='tools/call'&&request.headers['mcp-session-id']==='1'){request.socket.destroy();return;}
    const headers=new Headers();for(const [key,value] of Object.entries(request.headers))if(typeof value==='string')headers.set(key,value);
    const remote=await fetch(http.url,{method:request.method??'GET',headers,...(body.length?{body}:{})});
    const responseHeaders:Record<string,string>={};remote.headers.forEach((value,key)=>{responseHeaders[key]=value;});
    response.writeHead(remote.status,responseHeaders);response.end(Buffer.from(await remote.arrayBuffer()));
  }):undefined;
  if(proxy)await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const address=proxy?.address();
  const url=address&&typeof address!=='string'?`http://127.0.0.1:${address.port}`:http.url.href;
  const tools=new ToolExecutor();await tools.addMcp('fixture',{transport:'http',url},{});
  const find=(name:string)=>{const result=tools.definitions.find(t=>t.type==='function'&&t.name.startsWith(`mcp_fixture_${name}_`));if(!result||result.type!=='function')throw new TypeError('missing tool');return result.name;};
  return {tools,read:find('read'),write:find('write'),calls,held,release,initializing,allowInitialize,
    listings:()=>listings,paginate:()=>{paginate=true;},notify:()=>{notify=true;},initializes:()=>initialized,expire:()=>{expired=initialized;},deny:()=>{unauthorized=true;},change:()=>{changed=true;},holdInit:()=>{holdInitialize=true;},
    async close(){release.resolve();allowInitialize.resolve();await tools.close();http.stop(true);if(proxy){const closing=new Promise<void>((resolve,reject)=>proxy.close(error=>error?reject(error):resolve()));proxy.closeAllConnections();await closing;}}};
}
