import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir=await mkdtemp(join(tmpdir(),'assistant-browser-qa-'));
const child=spawn(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome',['--remote-debugging-port=0',`--user-data-dir=${dir}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:['ignore','ignore','pipe']});
let connection,client,site;
try {
 const endpoint=await new Promise((res,rej)=>{let output='';const timer=setTimeout(()=>rej(new Error('Chrome startup timeout')),10000);child.stderr.on('data',chunk=>{output+=String(chunk);const match=output.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);res(match[1]);}});child.once('error',rej);});
 connection=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 const context=connection.contexts()[0];assert(context);
 site=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><title>Browser QA ${req.url}</title><body><p>${req.url} ${req.headers.cookie??'none'}</p><button onclick="document.body.dataset.clicked='yes'">Apply</button></body></html>`);});
 site.listen(0,'127.0.0.1');await once(site,'listening');
 const base=`http://127.0.0.1:${site.address().port}`;
 const connect=async()=>{client=new Client({name:'builtin-browser-acceptance',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('var/browser-worker.mjs'),endpoint],env:{OUTPUT_DIR:dir},stderr:'inherit'}));};
 const call=async(name,args={},signal)=>client.callTool({name,arguments:args},undefined,{...(signal?{signal}:{}),timeout:15000});
 const text=r=>r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 await context.addCookies([{name:'session',value:'fixture-auth',url:base}]);
 const a=context.pages()[0];await a.goto(base+'/a');await a.bringToFront();
 await connect();assert((await client.listTools()).tools.some(t=>t.name==='browser_snapshot'));
 const snap=text(await call('browser_snapshot'));assert(snap.includes('session=fixture-auth'));
 const ref=snap.match(/button "Apply" \[ref=([^\]]+)\]/)?.[1];assert(ref);
 const b=await context.newPage();await b.goto(base+'/b');await b.bringToFront();
 const rejected=await call('browser_click',{target:ref});assert.equal(rejected.isError,true,text(rejected));
 assert.equal(await b.getAttribute('body','data-clicked'),null);
 const current=text(await call('browser_snapshot'));assert(current.includes(`Page URL: ${base}/b`),current);
 const fresh=current.match(/button "Apply" \[ref=([^\]]+)\]/)?.[1];assert(fresh);
 const clicked=await call('browser_click',{target:fresh});assert(!clicked.isError,text(clicked));assert.equal(await b.getAttribute('body','data-clicked'),'yes');
 assert.equal(context.pages().length,2);
 const identities=JSON.parse(text(await call('browser_tabs',{action:'list'}))).tabs;
 const aid=identities.find(t=>t.url===base+'/a').tab_id;
 const bid=identities.find(t=>t.url===base+'/b').tab_id;
 await b.evaluate(()=>{document.body.removeAttribute('data-clicked');document.querySelector('button').style.display='none';});
 const abort=new AbortController();const waiting=call('browser_click',{target:'button'},abort.signal);const timer=setTimeout(()=>abort.abort(),100);
 try{await assert.rejects(waiting);}finally{clearTimeout(timer);await client.close();client=undefined;}
 assert(connection.isConnected());await b.evaluate(()=>{document.querySelector('button').style.display='';});await connect();const again=text(await call('browser_snapshot'));assert(again.includes(`Page URL: ${base}/b`),again);assert.equal(context.pages().length,2);assert.equal(await b.getAttribute('body','data-clicked'),null);
 const reconnected=JSON.parse(text(await call('browser_tabs',{action:'list'}))).tabs;
 assert(reconnected.some(t=>t.tab_id===aid));assert(reconnected.some(t=>t.tab_id===bid));
 assert.equal((await call('browser_tabs',{action:'close',index:0})).isError,true);
 const closed=await call('browser_tabs',{action:'close',tab_id:bid});assert(!closed.isError,text(closed));
 assert.equal(a.isClosed(),false);assert.equal(b.isClosed(),true);
 const remaining=JSON.parse(text(await call('browser_tabs',{action:'list'}))).tabs;
 assert.deepEqual(remaining.map(t=>t.tab_id),[aid]);
 console.log(JSON.stringify({passed:true,sharedCookie:true,sameTabs:true,desktopTabChange:true,staleReferenceRejected:true,abortAndReconnect:true,noLateClick:true,stableTabIdentity:true}));
} finally {
 await client?.close();await connection?.close();
 const exit=child.exitCode===null?once(child,'exit'):Promise.resolve();child.kill('SIGTERM');await exit;
 if(site)await new Promise(resolve=>site.close(resolve));
 await rm(dir,{recursive:true,force:true});
}
