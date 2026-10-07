import WebSocket from 'ws';
import {readFile} from 'node:fs/promises';
import { z } from 'zod';
import {ScreenError} from '../packages/screen/protocol.ts';
const Config=z.object({control_url:z.url(),vm_id:z.uuid(),client_token:z.string(),vm_token:z.string()});
const config=Config.parse(JSON.parse(await readFile('.local/remote-connection.json','utf8')));
const endpoint=new URL(`/v1/vms/${config.vm_id}/screen`,config.control_url);endpoint.protocol='wss:';
const connections:WebSocket[]=[];
type RemotePeer={readonly ws:WebSocket;readonly frames:string[];readonly next:()=>Promise<string>};
function connect(token:string):Promise<RemotePeer>{
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(endpoint,{headers:{Authorization:`Bearer ${token}`}});connections.push(ws);
  const frames:string[]=[];const pending:Array<(frame:string)=>void>=[];
  const timer=setTimeout(()=>{ws.terminate();reject(new ScreenError('connect_timeout'));},15000);
  ws.on('error',()=>{clearTimeout(timer);reject(new ScreenError('transport_error'));});
  ws.on('unexpected-response',(_request,response)=>{clearTimeout(timer);response.resume();ws.terminate();reject(new ScreenError(`http_${response.statusCode}`));});
  ws.on('message',data=>{const frame=data.toString();const consume=pending.shift();if(consume)consume(frame);else frames.push(frame);});
  ws.once('open',()=>{clearTimeout(timer);resolve({ws,frames,next:()=>{
   const frame=frames.shift();if(frame!==undefined)return Promise.resolve(frame);
   return new Promise((accept,fail)=>{const expire=setTimeout(()=>fail(new ScreenError('frame_timeout')),15000);pending.push(value=>{clearTimeout(expire);accept(value);});});
  }});});
 });
}
async function receive(peer:RemotePeer,type:string){
 for(let i=0;i<16;i++){const frame=z.object({type:z.string()}).passthrough().parse(JSON.parse(await peer.next()));if(frame.type===type)return frame;}
 throw new ScreenError('expected_frame_absent');
}
function check(condition:boolean,name:string){if(!condition)throw new ScreenError(`assertion_failed:${name}`);console.log(`PASS ${name}`);}
try{
 const client=await connect(config.client_token),vm=await connect(config.vm_token);
 await receive(client,'peer_ready');await receive(vm,'peer_ready');console.log('PASS authenticated client and VM joined; peer_ready delivered');
 client.ws.send(JSON.stringify({type:'offer',sdp:'smoke-offer'}));
 check((await receive(vm,'offer'))['sdp']==='smoke-offer','client offer relayed to VM');
 vm.ws.send(JSON.stringify({type:'answer',sdp:'smoke-answer'}));
 check((await receive(client,'answer'))['sdp']==='smoke-answer','VM answer relayed to client');
 client.ws.send(JSON.stringify({type:'ice',candidate:null}));check((await receive(vm,'ice'))['candidate']===null,'ICE relayed');
 try{await connect(config.client_token);throw new ScreenError('duplicate_viewer_accepted');}catch(error){if(!(error instanceof ScreenError))throw error;check(error.code==='http_409','second viewer rejected409');}
 const closed=new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(new ScreenError('role_close_timeout')),15000);vm.ws.once('close',code=>{clearTimeout(timer);resolve(code);});});
 vm.ws.send(JSON.stringify({type:'offer',sdp:'invalid-role'}));check(await closed===1008,'VM offer rejected by role enforcement');
 await receive(client,'peer_left');console.log('PASS counterpart disconnect delivered peer_left');
 const replacementVm=await connect(config.vm_token);
 await receive(client,'peer_ready');await receive(replacementVm,'peer_ready');
 client.ws.close();
 await receive(replacementVm,'peer_left');
 console.log('PASS client close without status still delivers peer_left');
 console.log('REMOTE SIGNALING SMOKE PASS; no credentials logged; media decoding not part of this signaling probe.');
}catch(error){
 console.error(error instanceof ScreenError?error.code:'remote_smoke_failed');process.exitCode=1;
}finally{
 for(const ws of connections){if(ws.readyState===WebSocket.OPEN)ws.close(1000);else if(ws.readyState!==WebSocket.CLOSED)ws.terminate();}
}
