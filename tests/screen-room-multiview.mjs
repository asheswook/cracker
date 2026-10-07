import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { resolve } from 'node:path';
import WebSocket from 'ws';
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
import { ScreenRoom } from './services/control/screen-room';
export { ScreenRoom };
export default {fetch(request,env){
 const url=new URL(request.url), headers=new Headers(request.headers);
 for(const [key,value] of Object.entries({'X-Screen-Role':url.searchParams.get('role')??'client','X-Screen-Token-Hash':url.searchParams.get('credential')??'fixture','X-Screen-VM':'00000000-0000-4000-8000-000000000001','X-Screen-Workspace':'00000000-0000-4000-8000-000000000002'}))headers.set(key,value);
 return env.ROOM.getByName(url.pathname).fetch(new Request(request,{headers}));
}};` }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:*'], plugins: [{ name: 'isolated-credential-db', setup(build) {
  build.onLoad({ filter: /services\/control\/db\.ts$/ }, () => ({ contents: `export function createDatabase(){ const sql=async(strings,...values)=>values[0]==='revoked'?[]:[{token_hash:values[0]}];sql.end=async()=>{};return sql;}`, loader: 'ts' }));
} }] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: 'ScreenRoom' }, bindings: { DATABASE: { connectionString: 'fixture' } } }));
const sockets = [];
const wait = async predicate => { const limit = Date.now() + 3000; while (!predicate()) { if (Date.now() > limit) throw new Error('room_deadline'); await new Promise(resolve => setTimeout(resolve, 10)); } };
try {
  const base = (await mf.ready).toString().replace('http:', 'ws:');
  const connect = async (path, role = 'client', version = 2, credential = 'fixture') => {
    const ws = new WebSocket(`${base}${path}?role=${role}&screen_version=${version}&credential=${credential}`);
    sockets.push(ws);
    const frames = [];
    ws.on('message', data => { if (String(data) !== 'pong') frames.push(JSON.parse(String(data))); });
    await once(ws, 'open');
    return { ws, frames };
  };
  const vm = await connect('modern', 'vm');
  const a = await connect('modern'), b = await connect('modern');
  await wait(() => a.frames.some(x => x.type === 'peer_ready') && b.frames.some(x => x.type === 'peer_ready'));
  const idA = a.frames.find(x => x.type === 'peer_ready').viewer_id, idB = b.frames.find(x => x.type === 'peer_ready').viewer_id;
  assert.notEqual(idA, idB); assert.equal(a.frames[0].version, 2);
  a.ws.send(JSON.stringify({ type: 'offer', sdp: 'offer-a', visible: false, viewer_id: idB }));
  b.ws.send(JSON.stringify({ type: 'offer', sdp: 'offer-b', visible: true }));
  await wait(() => vm.frames.filter(x => x.type === 'offer').length === 2);
  assert.equal(vm.frames.find(x => x.type === 'offer' && x.sdp === 'offer-a').viewer_id, idA);
  assert.equal(vm.frames.find(x => x.type === 'offer' && x.sdp === 'offer-a').visible, false);
  assert.equal(vm.frames.find(x => x.type === 'offer' && x.sdp === 'offer-b').viewer_id, idB);
  assert.equal(vm.frames.find(x => x.type === 'offer' && x.sdp === 'offer-b').visible, true);
  vm.ws.send(JSON.stringify({ type: 'answer', sdp: 'answer-a', viewer_id: idA }));
  await wait(() => a.frames.some(x => x.type === 'answer'));
  assert.equal(b.frames.some(x => x.type === 'answer'), false);
  vm.ws.send(JSON.stringify({ type: 'answer', sdp: 'must-not-broadcast' }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(a.frames.filter(x => x.type === 'answer').length, 1);
  const c = await connect('modern'), d = await connect('modern'), overflow = await connect('modern');
  await wait(() => overflow.ws.readyState === WebSocket.CLOSED);
  assert.equal(overflow.frames[0].code, 'viewer_limit_reached');
  assert.equal(c.ws.readyState, WebSocket.OPEN); assert.equal(d.ws.readyState, WebSocket.OPEN);
  a.ws.close(1000);
  await wait(() => vm.frames.some(x => x.type === 'peer_left' && x.viewer_id === idA));
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  assert.equal(b.frames.some(x => x.type === 'peer_left'), false);
  const revoked = await connect('revocation', 'client', 2, 'revoked');
  revoked.ws.send('ping');
  await wait(() => revoked.ws.readyState === WebSocket.CLOSED);
  const legacyVm = await connect('legacy', 'vm', 1), legacyA = await connect('legacy'), legacyB = await connect('legacy');
  await wait(() => legacyB.ws.readyState === WebSocket.CLOSED);
  assert.equal(legacyB.frames[0].code, 'viewer_already_connected');
  assert.equal(legacyA.frames[0].version, undefined); assert.equal(legacyVm.ws.readyState, WebSocket.OPEN);
  const restarted = await connect('modern', 'vm');
  await wait(() => vm.ws.readyState === WebSocket.CLOSED && restarted.frames.some(x => x.type === 'peer_ready'));
  b.ws.send(JSON.stringify({ type: 'offer', sdp: 'after-daemon-restart' }));
  await wait(() => restarted.frames.some(x => x.type === 'offer' && x.sdp === 'after-daemon-restart'));
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  console.log(JSON.stringify({ result: 'PASS', surface: 'actual local workerd ScreenRoom', credentialDatabase: 'isolated stub, production auth not claimed', viewers: 4, forgedViewerId: 'overwritten', answer: 'targeted', unscopedAnswer: 'not broadcast', close: 'isolated', revokedCredential: 'closed', legacyDaemon: 'single viewer fallback' }));
} finally {
  for (const socket of sockets) socket.terminate();
  await mf.dispose();
}
