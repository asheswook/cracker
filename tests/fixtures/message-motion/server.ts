import { join } from 'node:path';
const build=process.env['MESSAGE_MOTION_BUILD'];
if(!build)throw new TypeError('MESSAGE_MOTION_BUILD required');
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/')return new Response('<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><style>html,body,#root{height:100%;margin:0}.assistant-shell{display:block!important;height:100dvh}.main-surface{height:100%;margin:0!important}.fixture-controls{position:fixed;top:0;left:0;z-index:999;max-width:100%;display:flex;flex-wrap:wrap;gap:2px}.fixture-controls button{font-size:10px;padding:3px}</style><div id="root"></div><script type="module" src="/harness.js"></script></html>',{headers:{'content-type':'text/html'}});
  if(/^\/[a-zA-Z0-9._-]+$/.test(path)){const file=Bun.file(join(build,path.slice(1)));if(await file.exists())return new Response(file);}
  return new Response(null,{status:404});
}});
console.log(`READY http://127.0.0.1:${server.port}/ PID=${process.pid}`);
