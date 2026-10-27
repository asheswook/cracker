import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ScreenSession, FrameFreshness } from '../apps/web/src/screen-session';
import type { ScreenVideo } from '../apps/web/src/screen-session';
const originals = { WebSocket: globalThis.WebSocket, RTCPeerConnection: globalThis.RTCPeerConnection, MediaStream: globalThis.MediaStream,
  fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now };
let now = 100000, serial = 0;
const timers = new Map<number, { callback: () => void; interval: number; at: number }>();
let iceRequests = 0, iceWait: Promise<void> | undefined, offerWait: Promise<void> | undefined;
const sockets: Socket[] = [], peers: Peer[] = [], sessions: ScreenSession[] = [];
class Socket {
  static OPEN = 1; readyState = 1; sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(readonly url: URL) { sockets.push(this); }
  send(value: string) { this.sent.push(value); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class Channel {
  readyState = 'open'; bufferedAmount = 0; sent: string[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class Peer {
  connectionState = 'connected'; channel = new Channel(); localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate = null; onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: MediaStream[]; track?: MediaStreamTrack }) => void) | null = null;
  constructor() { peers.push(this); }
  addTransceiver() {} createDataChannel() { return this.channel; }
  async createOffer() { await offerWait; return { type: 'offer', sdp: 'test-offer' }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription() {} async addIceCandidate() {}
  close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
}
class Video implements ScreenVideo {
  srcObject: HTMLVideoElement['srcObject'] = null; readyState = 2; videoWidth = 640; currentTime = 0;
  onloadeddata: HTMLVideoElement['onloadeddata'] = null; ontimeupdate: HTMLVideoElement['ontimeupdate'] = null;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  play() { return Promise.resolve(); } pause() {}
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { const id = ++serial; this.callbacks.set(id, callback); return id; }
  cancelVideoFrameCallback(id: number) { this.callbacks.delete(id); }
  frame(time: number) {
    this.currentTime = time;
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    for (const callback of callbacks) callback(now, { mediaTime: time, presentationTime: now, expectedDisplayTime: now, width: 640, height: 480, presentedFrames: time * 30 });
  }
}
const turn = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const config = (visible: boolean, foreground = true) => ({ visible, foreground, controlAllowed: true });
function create() { const session = new ScreenSession(crypto.randomUUID(), 'https://test.invalid/'); sessions.push(session); return session; }
function latest<T>(values: readonly T[]): T { const value = values.at(-1); if (!value) throw new Error('missing fake'); return value; }
async function ready(session: ScreenSession, visible = false) {
  session.configure(config(visible)); const socket = latest(sockets);
  socket.receive({ type: 'peer_ready', version: 2, viewer_id: crypto.randomUUID() }); await turn();
  const peer = latest(peers); peer.channel.onopen?.(); return { socket, peer };
}
async function live(session: ScreenSession) {
  const pair = await ready(session, true); const video = new Video();
  pair.peer.ontrack?.({ streams: [new MediaStream()] }); session.attachVideo(video);
  pair.peer.channel.receive({ type: 'screen_visibility', visible: true }); video.frame(1); video.frame(2);
  expect(session.getSnapshot().phase).toBe('live'); return { ...pair, video };
}
function claim(session: ScreenSession, channel: Channel, epoch = 1) {
  session.claim(); const request: unknown = JSON.parse(channel.sent.at(-1) ?? 'null');
  if (!request || typeof request !== 'object' || !('command_id' in request)) throw new Error('missing claim');
  channel.receive({ type: 'input_lease', epoch, held: true, command_id: request.command_id }); return request;
}
test('key and pointer releases bypass data-channel backpressure, including lease release', async () => {
  const session = create(); const { peer } = await live(session); claim(session, peer.channel);
  peer.channel.sent.length = 0;
  session.send({ type: 'key', key: 'Control_L', action: 'down' });
  peer.channel.bufferedAmount = 65536;
  session.send({ type: 'key', key: 'a', action: 'down' });
  session.send({ type: 'key', key: 'Control_L', action: 'up' });
  session.send({ type: 'pointer_button', button: 0, action: 'up' });
  session.send({ type: 'pointer', x: 0.5, y: 0.5, button: 0, action: 'up' });
  session.release();
  expect(peer.channel.sent.map(value => JSON.parse(value))).toEqual([
    { type: 'input', epoch: 1, input: { type: 'key', key: 'Control_L', action: 'down' } },
    { type: 'input', epoch: 1, input: { type: 'key', key: 'Control_L', action: 'up' } },
    { type: 'input', epoch: 1, input: { type: 'pointer_button', button: 0, action: 'up' } },
    { type: 'input', epoch: 1, input: { type: 'pointer', x: 0.5, y: 0.5, button: 0, action: 'up' } },
    { type: 'input_release', epoch: 1 },
  ]);
});
beforeEach(() => {
  now = 100000; serial = 0; iceRequests = 0; iceWait = undefined; offerWait = undefined; sockets.length = 0; peers.length = 0; sessions.length = 0; timers.clear();
  function timer(callback: () => void, delay = 0, interval = 0) { const id = ++serial; timers.set(id, { callback, at: now + delay, interval }); return id; }
  Object.assign(globalThis, { WebSocket: Socket, RTCPeerConnection: Peer, MediaStream: class {},
    fetch: async () => { iceRequests++; await iceWait; return Response.json({ mode: 'direct', iceServers: [], expiresAt: null }); },
    setTimeout: (callback: () => void, delay: number) => timer(callback, delay), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, delay: number) => timer(callback, delay, delay), clearInterval: (id: number) => timers.delete(id) });
  Date.now = () => now;
});
afterEach(() => { for (const session of sessions) session.dispose(); const { now: originalNow, ...runtime } = originals; Object.assign(globalThis, runtime); Date.now = originalNow; });
test('foreground hidden prewarm offers media off and cannot claim or transmit input', async () => {
  const session = create(); const { socket, peer } = await ready(session);
  expect(socket.url.searchParams.get('screen_version')).toBe('2');
  expect(socket.sent.map(value => JSON.parse(value))).toContainEqual({ type: 'offer', sdp: 'test-offer', visible: false });
  expect(peer.channel.sent.map(value => JSON.parse(value))).toEqual([{ type: 'screen_visibility', visible: false }]);
  session.claim(); session.send({ type: 'text', text: 'blocked' }); expect(peer.channel.sent).toHaveLength(1); expect(iceRequests).toBe(1);
});
test('WebKit zero mediaTime uses newly presented frames and fences hidden or reattached callbacks', async () => {
  const session = create(); const { peer } = await ready(session, true); const video = new Video();
  peer.ontrack?.({ streams: [new MediaStream()] }); session.attachVideo(video);
  peer.channel.receive({ type: 'screen_visibility', visible: true });
  const deliver = (target: Video, presentedFrames: number) => {
    target.currentTime++;
    const callbacks = [...target.callbacks.values()]; target.callbacks.clear();
    for (const callback of callbacks) callback(now, { mediaTime: 0, presentationTime: now, expectedDisplayTime: now, width: 640, height: 480, presentedFrames });
  };
  deliver(video, 10); expect(session.getSnapshot().phase).toBe('waiting');
  deliver(video, 10); deliver(video, 9); deliver(video, 10);
  expect(session.getSnapshot().phase).toBe('waiting');
  deliver(video, 11); expect(session.getSnapshot().phase).toBe('live');
  expect(session.getSnapshot().held).toBe(false);
  const stale = [...video.callbacks.values()]; session.configure(config(false)); session.configure(config(true));
  for (const callback of stale) callback(now, { mediaTime: 0, presentationTime: now, expectedDisplayTime: now, width: 640, height: 480, presentedFrames: 999 });
  expect(session.getSnapshot().phase).toBe('waiting');
  peer.channel.receive({ type: 'screen_visibility', visible: true });
  deliver(video, 12); expect(session.getSnapshot().phase).toBe('waiting');
  deliver(video, 13); expect(session.getSnapshot().phase).toBe('live');
  const old = [...video.callbacks.values()]; const replacement = new Video(); session.attachVideo(replacement);
  for (const callback of old) callback(now, { mediaTime: 0, presentationTime: now, expectedDisplayTime: now, width: 640, height: 480, presentedFrames: 1000 });
  deliver(replacement, 1); expect(session.getSnapshot().phase).toBe('waiting');
  deliver(replacement, 2); expect(session.getSnapshot().phase).toBe('live');
});
test('freshness rejects invalid or regressed counters and separates fallback clock domains', () => {
  const fresh = new FrameFreshness();
  expect(fresh.accept(10, { mediaTime: 0, presentedFrames: 10 })).toBe(false);
  for (const count of [NaN, Infinity, -1, 10.5, 10, 9, 10]) expect(fresh.accept(20, { mediaTime: 20, presentedFrames: count })).toBe(false);
  expect(fresh.accept(20, { mediaTime: 0, presentedFrames: 11 })).toBe(true);
  expect(fresh.accept(100, { mediaTime: 100 })).toBe(false);
  expect(fresh.accept(101, { mediaTime: 100 })).toBe(false);
  expect(fresh.accept(102, { mediaTime: 101 })).toBe(true);
  expect(fresh.accept(200)).toBe(false); expect(fresh.accept(201)).toBe(true);
  expect(fresh.accept(202, { presentedFrames: 12 })).toBe(false);
  expect(fresh.accept(203, { presentedFrames: 13 })).toBe(true);
  fresh.reset(); expect(fresh.accept(204, { presentedFrames: 1 })).toBe(false);
  expect(fresh.accept(205, { presentedFrames: 2 })).toBe(true);
});
test('early track retained; fresh decoded frame required after visibility ACK and stale callbacks fenced', async () => {
  const session = create(); const { peer } = await ready(session); peer.ontrack?.({ streams: [new MediaStream()] });
  const video = new Video(); session.attachVideo(video); expect(video.srcObject).toBeNull();
  session.configure(config(true)); expect(session.getSnapshot().phase).not.toBe('live');
  peer.channel.receive({ type: 'screen_visibility', visible: true }); video.frame(1); expect(session.getSnapshot().phase).not.toBe('live'); video.frame(2); expect(session.getSnapshot().phase).toBe('live');
  const stale = [...video.callbacks.values()]; session.configure(config(false)); expect(video.srcObject).toBeNull(); session.configure(config(true));
  for (const callback of stale) callback(0, { mediaTime: 3, presentationTime: 0, expectedDisplayTime: 0, width: 640, height: 480, presentedFrames: 3 });
  expect(session.getSnapshot().phase).not.toBe('live');
  peer.channel.receive({ type: 'screen_visibility', visible: true }); video.frame(3); expect(session.getSnapshot().phase).not.toBe('live'); video.frame(4); expect(session.getSnapshot().phase).toBe('live');
});
test('explicit matching lease gates input; hide revokes synchronously and late grant is released', async () => {
  const session = create(); const { peer } = await live(session);
  session.send({ type: 'key', key: 'A', action: 'down' }); expect(peer.channel.sent.some(value => JSON.parse(value).type === 'input')).toBe(false);
  claim(session, peer.channel); session.send({ type: 'key', key: 'A', action: 'down' });
  expect(JSON.parse(peer.channel.sent.at(-1) ?? '')).toMatchObject({ type: 'input', epoch: 1 });
  let pending = 'composing'; session.onRevoke(() => { pending = ''; }); session.configure(config(false)); session.configure(config(true));
  expect(pending).toBe(''); expect(session.getSnapshot().held).toBe(false);
  peer.channel.receive({ type: 'input_lease', epoch: 2, held: true, command_id: crypto.randomUUID() });
  expect(JSON.parse(peer.channel.sent.at(-1) ?? '')).toEqual({ type: 'input_release', epoch: 2 }); expect(session.getSnapshot().held).toBe(false);
});
test('two independent viewers do not infer input ownership from global user state', async () => {
  const a = create(), b = create(); const first = await live(a), second = await live(b); claim(a, first.peer.channel);
  a.send({ type: 'text', text: 'allowed' }); b.send({ type: 'text', text: 'blocked' });
  expect(first.peer.channel.sent.filter(value => JSON.parse(value).type === 'input')).toHaveLength(1);
  expect(second.peer.channel.sent.filter(value => JSON.parse(value).type === 'input')).toHaveLength(0);
  first.peer.channel.receive({ type: 'input_lease', epoch: 2, held: false }); a.send({ type: 'text', text: 'revoked' });
  expect(first.peer.channel.sent.filter(value => JSON.parse(value).type === 'input')).toHaveLength(1);
});
test('hidden legacy server releases sole slot; offer starts only on visible reconnect', async () => {
  const session = create(); session.configure(config(false)); latest(sockets).receive({ type: 'peer_ready' }); await turn();
  expect(latest(sockets).readyState).toBe(3); expect(peers).toHaveLength(0); expect(iceRequests).toBe(0);
  session.configure(config(false)); expect(sockets).toHaveLength(1);
  session.attachVideo(new Video()); session.configure(config(true)); latest(sockets).receive({ type: 'peer_ready' }); await turn();
  expect(peers).toHaveLength(1); expect(JSON.parse(latest(sockets).sent.at(-1) ?? '')).toEqual({ type: 'offer', sdp: 'test-offer' });
});
test('background during credentials cancels late peer creation and all session timers', async () => {
  let release = () => {}; iceWait = new Promise<void>(resolve => { release = resolve; });
  const session = create(); session.configure(config(false)); latest(sockets).receive({ type: 'peer_ready', version: 2, viewer_id: crypto.randomUUID() }); await turn();
  session.suspend(); release(); await turn(); expect(peers).toHaveLength(0); expect(latest(sockets).readyState).toBe(3); expect(timers.size).toBe(0);
});
test('terminal authentication error does not silently reconnect on render; explicit reconnect does', async () => {
  const session = create(); session.configure(config(true)); latest(sockets).close(1008);
  session.configure(config(true)); expect(sockets).toHaveLength(1); expect(session.getSnapshot().phase).toBe('error');
  session.reconnect(); expect(sockets).toHaveLength(2); session.dispose(); expect(timers.size).toBe(0);
});
test('frame freshness excludes first, repeated and reset old callbacks', () => {
  const frame = new FrameFreshness(); expect(frame.accept(1)).toBe(false); expect(frame.accept(1)).toBe(false); expect(frame.accept(2)).toBe(true); expect(frame.accept(2)).toBe(false); frame.reset(); expect(frame.accept(3)).toBe(false);
});

test('old sender remains fenced after hide, reveal and a new explicit lease', async () => {
  const session = create(); const { peer, video } = await live(session); claim(session, peer.channel);
  const staleSend = session.sender(); session.configure(config(false)); session.configure(config(true));
  peer.channel.receive({ type: 'screen_visibility', visible: true }); video.frame(3); video.frame(4); claim(session, peer.channel, 2);
  staleSend({ type: 'text', text: 'old queued composition' }); session.sender()({ type: 'text', text: 'new input' });
  const input = peer.channel.sent.map(value => JSON.parse(value)).filter(value => value.type === 'input');
  expect(input).toHaveLength(1); expect(input[0].epoch).toBe(2); expect(input[0].input.text).toBe('new input');
});

function advance(ms: number) {
  now += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) {
    if (timer.interval) timer.at = now + timer.interval; else timers.delete(id);
    timer.callback();
  }
}
test('lease timeout never auto-reclaims; duplicate grant is idempotent and hidden heartbeat is absent', async () => {
  const session = create(); const { peer } = await live(session); session.claim();
  const pending = JSON.parse(peer.channel.sent.at(-1) ?? ''); advance(5000);
  expect(session.getSnapshot().claiming).toBe(false); expect(session.getSnapshot().held).toBe(false);
  peer.channel.receive({ type: 'input_lease', held: true, epoch: 1, command_id: pending.command_id });
  expect(JSON.parse(peer.channel.sent.at(-1) ?? '')).toEqual({ type: 'input_release', epoch: 1 });
  const accepted = claim(session, peer.channel, 2); const before = peer.channel.sent.length;
  peer.channel.receive({ type: 'input_lease', held: true, epoch: 2, command_id: accepted.command_id });
  expect(peer.channel.sent).toHaveLength(before); expect(session.getSnapshot().held).toBe(true);
  session.configure(config(false)); const hidden = peer.channel.sent.length; advance(10000);
  expect(peer.channel.sent).toHaveLength(hidden);
});
test('network retries are bounded, stale socket cannot resurrect, new VM has a fresh budget', async () => {
  const session = create(); session.configure(config(false)); const old = latest(sockets);
  for (let index = 0; index < 3; index++) { latest(sockets).onerror?.(); if (index < 2) advance(1500); }
  expect(sockets).toHaveLength(3); expect(session.getSnapshot().phase).toBe('error'); expect(timers.size).toBe(0);
  old.receive({ type: 'peer_ready', version: 2, viewer_id: crypto.randomUUID() }); await turn(); expect(peers).toHaveLength(0);
  const other = create(); other.configure(config(false)); expect(sockets).toHaveLength(4); expect(other.getSnapshot().phase).toBe('connecting');
});

test('valid screen metadata is harmless; obsolete claim refusal cannot clear newer pending claim', async () => {
  const session = create(); const { peer } = await live(session);
  peer.channel.receive({ type: 'screen', width: 1364, height: 1024, control: 'user', unicode_input: 'utf8_clipboard' });
  expect(session.getSnapshot().inputStatus).toBe('');
  session.claim(); const pending = JSON.parse(peer.channel.sent.at(-1) ?? '');
  peer.channel.receive({ type: 'input_lease', epoch: 0, held: false });
  peer.channel.receive({ type: 'input_lease', epoch: 0, held: false, command_id: crypto.randomUUID() });
  expect(session.getSnapshot().claiming).toBe(true);
  peer.channel.receive({ type: 'input_lease', epoch: 1, held: true, command_id: pending.command_id });
  expect(session.getSnapshot().held).toBe(true);
});

test('new attached viewer stays connecting until peer readiness, not merely panel visibility', () => {
  const session = create(); session.attachVideo(new Video()); session.configure(config(true));
  expect(session.getSnapshot().phase).toBe('connecting'); expect(peers).toHaveLength(0);
});

test('hidden stalled offer with no RTC state event gets bounded handshake retry and ignores late completion', async () => {
  let finish = () => {}; offerWait = new Promise<void>(resolve => { finish = resolve; });
  const session = create(); session.configure(config(false)); const first = latest(sockets);
  first.receive({ type: 'peer_ready', version: 2, viewer_id: crypto.randomUUID() }); await turn();
  latest(peers).connectionState = 'new'; advance(25000);
  expect(session.getSnapshot().phase).toBe('retrying'); expect(first.readyState).toBe(3); expect(latest(peers).connectionState).toBe('closed');
  finish(); await turn(); expect(first.sent.some(value => value.includes('test-offer'))).toBe(false);
  advance(1500); expect(sockets).toHaveLength(2);
});
test('hidden connected plus open handshake clears deadline without expecting any frames', async () => {
  const session = create(); const { peer, socket } = await ready(session, false);
  advance(90000);
  expect(peer.connectionState).toBe('connected'); expect(socket.readyState).toBe(1); expect(sockets).toHaveLength(1);
  expect(session.getSnapshot().phase).toBe('waiting'); expect(session.getSnapshot().visible).toBe(false);
});
test('connected peer without open datachannel still times out; visible frame deadline is independent', async () => {
  const session = create(); session.configure(config(false)); latest(sockets).receive({ type: 'peer_ready', version: 2, viewer_id: crypto.randomUUID() }); await turn();
  const peer = latest(peers); peer.channel.readyState = 'connecting'; peer.onconnectionstatechange?.(); advance(25000);
  expect(session.getSnapshot().phase).toBe('retrying');
  const visible = create(); visible.attachVideo(new Video()); await ready(visible, true); advance(25000);
  expect(visible.getSnapshot().phase).toBe('retrying');
});
test('opening the viewer retries an exhausted hidden handshake without a separate reconnect tap', () => {
  const session = create(); session.configure(config(false));
  for (let index = 0; index < 3; index++) { advance(25000); if (index < 2) advance(1500); }
  expect(session.getSnapshot().phase).toBe('error'); expect(sockets).toHaveLength(3);
  session.attachVideo(new Video()); session.configure(config(true));
  expect(session.getSnapshot().phase).toBe('connecting'); expect(sockets).toHaveLength(4);
});

test('successful video resets the consecutive failure budget across separate interruptions', async () => {
  const session = create();
  for (let interruption = 0; interruption < 4; interruption++) {
    const { socket } = await live(session);
    socket.onerror?.();
    expect(session.getSnapshot().phase).toBe('retrying');
    advance(1500);
  }
});

test('a transient capture failure automatically reconnects and fences the previous video', async () => {
  const session = create(); const { peer, video } = await live(session);
  claim(session, peer.channel);
  peer.channel.receive({ type: 'screen_error', code: 'capture_failed' });
  expect(session.getSnapshot().phase).toBe('retrying');
  expect(session.getSnapshot().held).toBe(false); expect(video.srcObject).toBeNull();
  advance(1500); expect(sockets).toHaveLength(2);
});

test.each(['screen_connection_failed', 'ice_credentials_refresh'])('transient daemon %s retries without treating it as an authentication denial', async code => {
  const session = create(); const { socket } = await ready(session);
  socket.receive({ type: 'screen_error', code });
  expect(session.getSnapshot().phase).toBe('retrying');
  advance(1500); expect(sockets).toHaveLength(2);
});

test('a disconnected hidden prewarm has a recovery deadline even with no video frames', async () => {
  const session = create(); const { peer } = await ready(session);
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange?.();
  advance(25000);
  expect(session.getSnapshot().phase).toBe('retrying');
  advance(1500); expect(sockets).toHaveLength(2);
});

test('opening the viewer cannot erase a terminal authorization rejection', () => {
  const session = create(); session.configure(config(false)); latest(sockets).close(1008);
  session.attachVideo(new Video()); session.configure(config(true));
  expect(session.getSnapshot().phase).toBe('error'); expect(sockets).toHaveLength(1);
});
