import { z } from 'zod';
import { fetchScreenIce, refreshDelay, rtcIceServers } from '../../../packages/screen/ice';
import { Dimensions, Input } from '../../../packages/screen/protocol';
import { SCREEN_VERSION, ViewerEvent } from '../../../packages/screen/session-protocol';
import type { ViewerCommand } from '../../../packages/screen/session-protocol';
const Signal = z.object({ type: z.string(), version: z.number().optional(), viewer_id: z.uuid().optional(),
  sdp: z.string().optional(), code: z.string().optional(), candidate: z.object({ candidate: z.string(),
    sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().nullable().optional() }).nullable().optional() });
const ScreenMetadata = Dimensions.extend({ type: z.literal('screen'), control: z.enum(['agent', 'user']),
  unicode_input: z.enum(['utf8_clipboard', 'unavailable']).optional() });
const transientScreenError = (code: string | undefined) => code === 'screen_connection_failed' || code === 'capture_failed' || code === 'ice_credentials_refresh';
const releasesInput = (input: Input) => (input.type === 'key' || input.type === 'pointer_button' || input.type === 'pointer') && input.action === 'up';
export type ScreenPhase = 'connecting' | 'waiting' | 'retrying' | 'error' | 'live';
export type ScreenSnapshot = Readonly<{ state: string; phase: ScreenPhase; open: boolean; inputStatus: string;
  held: boolean; claiming: boolean; inputGeneration: number; protocol: 'pending' | 'v2' | 'legacy'; visible: boolean }>;
export type ScreenVideo = Pick<HTMLVideoElement, 'srcObject' | 'readyState' | 'videoWidth' | 'currentTime' | 'play' | 'pause' | 'requestVideoFrameCallback' | 'cancelVideoFrameCallback' | 'onloadeddata' | 'ontimeupdate'>;
export class FrameFreshness {
  private previous: number | undefined;
  private domain: 'frames' | 'media' | 'current' | undefined;
  reset() { this.previous = undefined; this.domain = undefined; }
  accept(currentTime: number, metadata?: Readonly<{ presentedFrames?: number; mediaTime?: number }>) {
    const domain = metadata?.presentedFrames !== undefined ? 'frames' : metadata?.mediaTime !== undefined ? 'media' : 'current';
    const value = domain === 'frames' ? metadata?.presentedFrames : domain === 'media' ? metadata?.mediaTime : currentTime;
    if (value === undefined || !Number.isFinite(value) || value < 0 || (domain === 'frames' && !Number.isSafeInteger(value))) return false;
    if (this.domain !== domain || this.previous === undefined) {
      this.domain = domain; this.previous = value; return false;
    }
    if (value <= this.previous) return false;
    this.previous = value; return true;
  }
}
export class ScreenSession {
  private value: ScreenSnapshot = { state: '연결 준비 중', phase: 'connecting', open: false, inputStatus: '', held: false, claiming: false, inputGeneration: 0, protocol: 'pending', visible: false };
  private readonly listeners = new Set<() => void>();
  private readonly revocations = new Set<(reason: 'authorization' | 'revoked') => void>();
  private foreground = false;
  private wanted = false;
  private allowed = false;
  private disposed = false;
  private blocked = false;
  private retryOnReveal = false;
  private legacyOnly = false;
  private generation = 0;
  private peerGeneration = 0;
  private mediaGeneration = 0;
  private retries = 0;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private video: ScreenVideo | null = null;
  private frameCallback: number | null = null;
  private readonly freshness = new FrameFreshness();
  private lastFrame = 0;
  private mediaApplied = false;
  private ready = false;
  private offering = false;
  private hasDescription = false;
  private candidates: RTCIceCandidateInit[] = [];
  private leaseEpoch = -1;
  private claimId: string | undefined;
  private claimTimer: ReturnType<typeof setTimeout> | undefined;
  private credentialRequest: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private handshakeDeadline: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  constructor(readonly vmId: string, private readonly origin: string) {}
  getSnapshot = () => this.value;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  onRevoke = (callback: (reason: 'authorization' | 'revoked') => void) => { this.revocations.add(callback); return () => { this.revocations.delete(callback); }; };
  private patch(value: Partial<ScreenSnapshot>) {
    const next = { ...this.value, ...value };
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next; for (const callback of this.listeners) callback();
  }
  private command(value: ViewerCommand) {
    const release = value.type === 'input_release' || (value.type === 'input' && releasesInput(value.input));
    if (this.channel?.readyState !== 'open' || (!release && this.channel.bufferedAmount >= 65536)) return false;
    this.channel.send(JSON.stringify(value)); return true;
  }
  private revoke(release = true, reason: 'authorization' | 'revoked' = 'revoked') {
    clearTimeout(this.claimTimer); this.claimTimer = undefined;
    const held = this.value.held;
    this.claimId = undefined;
    this.patch({ held: false, claiming: false, inputGeneration: this.value.inputGeneration + 1 });
    for (const callback of this.revocations) callback(reason);
    if (release && held && this.value.protocol === 'v2' && this.leaseEpoch >= 0) this.command({ type: 'input_release', epoch: this.leaseEpoch });
  }
  configure({ foreground, visible, controlAllowed }: Readonly<{ foreground: boolean; visible: boolean; controlAllowed: boolean }>) {
    if (this.disposed) return;
    const showing = foreground && visible && Boolean(this.video), changed = showing !== this.value.visible;
    if (foreground && !this.foreground) { this.blocked = false; this.retries = 0; }
    if (showing && changed && this.blocked && this.retryOnReveal) { this.blocked = false; this.retries = 0; }
    this.foreground = foreground; this.wanted = visible;
    if (!showing || !controlAllowed) this.revoke(true, showing ? 'authorization' : 'revoked');
    this.allowed = controlAllowed;
    this.patch({ visible: showing });
    if (!foreground) { this.stop(); return; }
    if (!this.ws && !this.retryTimer) this.start();
    if (changed) {
      this.mediaApplied = false; this.stopFrames();
      if (!this.blocked) this.patch({ phase: showing && this.value.protocol === 'pending' ? 'connecting' : 'waiting',
        state: showing ? this.value.protocol === 'pending' ? '컴퓨터 연결 확인 중' : '첫 화면을 기다리고 있어요.' : '컴퓨터 연결 준비됨' });
      if (this.value.protocol === 'v2') this.command({ type: 'screen_visibility', visible: showing });
      else if (!showing && this.value.protocol === 'legacy') this.stop();
      if (showing && this.ready && !this.blocked) { this.armDeadline(); void this.offer().catch(() => this.fail('화면 연결을 설정하지 못했어요.', true)); }
      else if (!showing) { clearTimeout(this.deadline); this.deadline = undefined; }
    }
  }
  attachVideo(element: ScreenVideo | null) {
    if (element === this.video) return;
    this.stopFrames(); this.video = element;
    this.configure({ foreground: this.foreground, visible: this.wanted, controlAllowed: this.allowed });
    if (element) this.bindFrames();
  }
  private stopFrames() {
    this.mediaGeneration++; this.freshness.reset(); this.lastFrame = 0;
    if (this.frameCallback !== null) this.video?.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
    if (this.video) { this.video.onloadeddata = null; this.video.ontimeupdate = null; this.video.pause(); this.video.srcObject = null; }
    if (this.value.phase === 'live') this.patch({ phase: 'waiting', state: '첫 화면을 기다리고 있어요.' });
  }
  private bindFrames() {
    const element = this.video, peer = this.pc;
    if (!element || !peer || !this.stream || !this.value.visible || !this.mediaApplied) return;
    this.stopFrames();
    const generation = this.mediaGeneration;
    element.srcObject = this.stream;
    void element.play().catch(() => { if (generation === this.mediaGeneration) this.fail('영상 재생을 시작하지 못했어요. 다시 연결해 주세요.'); });
    const received = (_now?: number, metadata?: VideoFrameCallbackMetadata) => {
      if (generation !== this.mediaGeneration || element !== this.video || peer !== this.pc || !this.value.visible || !this.mediaApplied) return;
      if (element.readyState >= 2 && element.videoWidth && this.freshness.accept(element.currentTime, metadata)) {
        this.lastFrame = Date.now();
        if (peer.connectionState === 'connected') {
          clearTimeout(this.deadline); this.deadline = undefined;
          this.retries = 0; this.retryOnReveal = false;
          this.patch({ phase: 'live', state: '실시간 화면', open: this.channel?.readyState === 'open' });
        }
      }
      if (typeof element.requestVideoFrameCallback === 'function') this.frameCallback = element.requestVideoFrameCallback(received);
    };
    if (typeof element.requestVideoFrameCallback === 'function') this.frameCallback = element.requestVideoFrameCallback(received);
    else { element.onloadeddata = () => received(); element.ontimeupdate = () => received(); }
  }
  private armHandshake() {
    if (this.handshakeDeadline !== undefined) return;
    this.handshakeDeadline = setTimeout(() => this.fail('컴퓨터 연결 준비가 지연되고 있어요. 다시 연결해 주세요.', true), 25000);
  }
  private handshakeReady() {
    if (this.pc?.connectionState === 'connected' && this.channel?.readyState === 'open') {
      clearTimeout(this.handshakeDeadline); this.handshakeDeadline = undefined;
      if (!this.value.visible) { this.retries = 0; this.retryOnReveal = false; }
    }
  }
  private armDeadline() {
    clearTimeout(this.deadline);
    if (this.value.visible) this.deadline = setTimeout(() => this.fail('화면을 받지 못했어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.', true), 25000);
  }
  private start() {
    if (!this.foreground || this.disposed || this.ws || this.blocked || (this.legacyOnly && !this.value.visible)) return;
    const generation = ++this.generation;
    this.patch({ state: '컴퓨터 연결 확인 중', phase: this.retries ? 'retrying' : 'connecting', protocol: 'pending', inputStatus: '' });
    const url = new URL(`/v1/vms/${this.vmId}/screen`, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('screen_version', String(SCREEN_VERSION));
    const ws = new WebSocket(url); this.ws = ws;
    const current = () => this.ws === ws && this.generation === generation && !this.disposed;
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      if (this.value.protocol === 'v2' && this.value.held && this.value.visible && this.allowed) this.command({ type: 'input_heartbeat', epoch: this.leaseEpoch });
    }, 10000);
    this.watchdog = setInterval(() => {
      if (!this.value.visible || !this.lastFrame) return;
      const age = Date.now() - this.lastFrame;
      if (age > 15000) this.fail('화면 응답이 멈췄어요. 다시 연결해 주세요.', true);
      else if (age > 5000) { this.revoke(); this.patch({ phase: 'waiting', state: '화면 응답을 기다리고 있어요.' }); }
    }, 2000);
    this.armDeadline(); this.armHandshake();
    let queue = Promise.resolve();
    ws.onmessage = event => {
      if (!current() || event.data === 'pong') return;
      let data: z.infer<typeof Signal>;
      try { data = Signal.parse(JSON.parse(String(event.data))); }
      catch { this.fail('화면 연결 응답을 읽지 못했어요.'); return; }
      if (data.type === 'peer_left') { this.fail('컴퓨터가 연결을 종료했어요.', true); return; }
      if (data.type === 'screen_error' || data.type === 'error') {
        this.fail(data.code === 'viewer_limit_reached' ? '화면을 보고 있는 기기가 많아요. 다른 기기의 화면을 닫고 다시 연결해 주세요.'
          : data.code === 'viewer_already_connected' ? '다른 창에서 화면을 보고 있어요. 그 창을 닫고 다시 연결해 주세요.' : `화면을 열지 못했어요. (${data.code ?? 'screen'})`, transientScreenError(data.code)); return;
      }
      const peerGeneration = this.peerGeneration;
      queue = queue.then(async () => {
        if (!current() || peerGeneration !== this.peerGeneration) return;
        if (data.type === 'peer_ready') {
          this.ready = true;
          this.legacyOnly = !(data.version === 2 && data.viewer_id);
          if (this.legacyOnly && !this.value.visible) { this.stop(); this.patch({ protocol: 'legacy', phase: 'waiting', state: '화면을 열면 연결합니다.' }); return; }
          this.patch({ protocol: data.version === 2 && data.viewer_id ? 'v2' : 'legacy', phase: 'waiting', state: this.value.visible ? '첫 화면을 기다리고 있어요.' : '컴퓨터 연결 준비됨' });
          await this.offer();
        } else if (data.type === 'peer_waiting') this.patch({ state: '컴퓨터가 연결되기를 기다리고 있어요.' });
        else if (data.type === 'answer' && data.sdp && this.pc) {
          const peer = this.pc; await peer.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          if (!current() || peer !== this.pc) return;
          this.hasDescription = true;
          for (const candidate of this.candidates) { await peer.addIceCandidate(candidate); if (!current() || peer !== this.pc) return; }
          this.candidates = [];
        } else if (data.type === 'ice' && data.candidate && this.pc) {
          const candidate = { candidate: data.candidate.candidate, sdpMid: data.candidate.sdpMid ?? null, sdpMLineIndex: data.candidate.sdpMLineIndex ?? null };
          if (this.hasDescription) await this.pc.addIceCandidate(candidate); else this.candidates.push(candidate);
        }
      }).catch(() => { if (current() && peerGeneration === this.peerGeneration) this.fail('화면 연결을 설정하지 못했어요. 다시 연결해 주세요.', true); });
    };
    ws.onerror = () => { if (current()) this.fail('화면 서버에 연결할 수 없어요.', true); };
    ws.onclose = event => { if (current()) this.fail(event.code === 1008 ? '화면 연결 인증이 만료되거나 거절됐어요. 로그인 상태를 확인해 주세요.' : '화면 연결이 종료됐어요.', event.code !== 1008); };
  }
  private async offer() {
    if (this.offering || !this.foreground || !this.ready || !this.ws || (this.value.protocol !== 'v2' && !this.value.visible)) return;
    this.offering = true; this.armHandshake();
    const generation = this.generation, peerGeneration = this.peerGeneration, socket = this.ws;
    const request = new AbortController(); this.credentialRequest = request;
    let credentials;
    try { credentials = await fetchScreenIce(new URL(`/v1/vms/${this.vmId}/screen/ice`, this.origin), { signal: request.signal }); }
    catch (error) { if (request.signal.aborted || generation !== this.generation || peerGeneration !== this.peerGeneration) return; throw error; }
    if (this.disposed || !this.foreground || generation !== this.generation || peerGeneration !== this.peerGeneration || socket !== this.ws) return;
    const delay = refreshDelay(credentials);
    if (delay !== null) this.refreshTimer = setTimeout(() => {
      if (generation !== this.generation || peerGeneration !== this.peerGeneration) return;
      this.closePeer(); this.patch({ phase: 'retrying', state: '화면 연결을 갱신하고 있어요.' }); this.armDeadline();
      void this.offer().catch(() => { if (generation === this.generation) this.fail('화면 연결을 갱신하지 못했어요.', true); });
    }, delay);
    const peer = new RTCPeerConnection({ iceServers: rtcIceServers(credentials.iceServers) }); this.pc = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });
    const channel = peer.createDataChannel('input', { ordered: true }); this.channel = channel;
    const current = () => this.pc === peer && generation === this.generation && !this.disposed;
    channel.onopen = () => {
      if (!current()) return;
      this.patch({ open: true }); this.handshakeReady();
      if (this.value.protocol === 'v2') this.command({ type: 'screen_visibility', visible: this.value.visible });
    };
    channel.onclose = () => { if (current()) { this.revoke(); this.patch({ open: false }); } };
    channel.onmessage = event => {
      if (!current()) return;
      const raw: unknown = (() => { try { return JSON.parse(String(event.data)); } catch { return null; } })();
      if (ScreenMetadata.safeParse(raw).success) return;
      const result = ViewerEvent.safeParse(raw);
      if (!result.success) { this.patch({ inputStatus: '컴퓨터 응답을 읽지 못했어요.' }); return; }
      const data = result.data;
      if (data.type === 'screen_visibility') {
        if (data.visible !== this.value.visible) return;
        if (this.mediaApplied === data.visible) return;
        this.mediaApplied = data.visible; if (data.visible) this.bindFrames(); else this.stopFrames();
      } else if (data.type === 'input_lease') {
        if (data.epoch < this.leaseEpoch) return;
        if (!data.held && data.command_id && data.command_id !== this.claimId) return;
        if (data.held && this.value.held && data.epoch === this.leaseEpoch && this.value.visible && this.allowed) return;
        this.leaseEpoch = data.epoch;
        if (!data.held) {
          if (!data.command_id && this.claimId && !this.value.held) return;
          const denied = data.command_id === this.claimId && this.claimId !== undefined;
          this.revoke(false);
          if (denied) this.patch({ inputStatus: '이 기기의 제어 요청이 거절됐어요. 다른 기기의 제어 상태를 확인해 주세요.' });
          return;
        }
        if (!this.value.visible || !this.allowed || !this.mediaApplied || !this.claimId || data.command_id !== this.claimId) {
          this.command({ type: 'input_release', epoch: data.epoch }); return;
        }
        clearTimeout(this.claimTimer); this.claimTimer = undefined;
        this.claimId = undefined; this.patch({ held: true, claiming: false, inputStatus: '' });
      } else if (data.type === 'input_result') {
        if (!data.accepted) this.revoke();
        this.patch({ inputStatus: data.accepted ? '' : `입력이 거절됐어요. (${data.code ?? 'unknown'})` });
      }
      else this.fail(`화면을 열지 못했어요. (${data.code})`, transientScreenError(data.code));
    };
    peer.onicecandidate = event => { if (current() && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ice', candidate: event.candidate?.toJSON() ?? null })); };
    peer.ontrack = event => {
      if (!current()) return;
      this.stream = event.streams[0] ?? new MediaStream([event.track]);
      if (this.value.protocol === 'legacy') this.mediaApplied = this.value.visible;
      this.bindFrames();
    };
    peer.onconnectionstatechange = () => {
      if (!current()) return;
      this.handshakeReady();
      if (['failed', 'closed'].includes(peer.connectionState)) this.fail('화면 연결이 끊겼어요. 다시 연결해 주세요.', true);
      else if (peer.connectionState === 'disconnected') { this.revoke(); this.patch({ phase: 'waiting', state: '화면 연결이 끊겼어요. 다시 연결해 주세요.' }); this.armHandshake(); this.armDeadline(); }
    };
    try {
      const description = await peer.createOffer(); if (!current()) return;
      await peer.setLocalDescription(description); if (!current()) return;
    } catch (error) { if (!current()) return; throw error; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription?.sdp,
      ...(this.value.protocol === 'v2' ? { visible: this.value.visible } : {}) }));
  }
  claim = () => {
    if (!this.value.visible || !this.foreground || !this.allowed || this.value.phase !== 'live' || !this.value.open || this.value.held || this.claimId) return;
    if (this.value.protocol === 'legacy') { this.patch({ held: true }); return; }
    this.claimId = crypto.randomUUID(); this.patch({ claiming: true });
    if (!this.command({ type: 'input_claim', command_id: this.claimId })) this.revoke();
    else this.claimTimer = setTimeout(() => { this.revoke(); this.patch({ inputStatus: '이 기기의 제어 연결을 확인하지 못했어요. 다시 요청해 주세요.' }); }, 5000);
  };
  sender = () => { const generation = this.value.inputGeneration; return (value: unknown) => this.send(value, generation); };
  send = (value: unknown, generation = this.value.inputGeneration) => {
    if (generation !== this.value.inputGeneration) return;
    if (!this.foreground || !this.value.visible || !this.allowed || !this.value.held || this.value.phase !== 'live') return;
    const parsed = Input.safeParse(value); if (!parsed.success) return;
    if (this.value.protocol === 'v2') this.command({ type: 'input', epoch: this.leaseEpoch, input: parsed.data });
    else if (this.channel?.readyState === 'open' && (releasesInput(parsed.data) || this.channel.bufferedAmount < 65536)) this.channel.send(JSON.stringify(parsed.data));
  };
  private closePeer() {
    clearTimeout(this.handshakeDeadline); this.handshakeDeadline = undefined;
    this.revoke(); this.peerGeneration++; this.credentialRequest?.abort(); this.credentialRequest = null;
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined; this.stopFrames(); this.stream = null;
    const peer = this.pc, channel = this.channel; this.pc = null; this.channel = null;
    channel?.close(); peer?.close(); this.offering = false; this.hasDescription = false; this.candidates = []; this.mediaApplied = false; this.leaseEpoch = -1;
    this.patch({ open: false });
  }
  private stop() {
    this.generation++; clearTimeout(this.retryTimer); this.retryTimer = undefined; clearTimeout(this.deadline); this.deadline = undefined;
    clearInterval(this.heartbeat); clearInterval(this.watchdog); this.heartbeat = undefined; this.watchdog = undefined;
    this.closePeer(); const socket = this.ws; this.ws = null; this.ready = false; socket?.close(1000, 'viewer_closed');
  }
  private fail(message: string, retryable = false) {
    if (this.disposed || !this.ws) return;
    this.stop(); this.blocked = true; this.retryOnReveal = retryable; this.patch({ inputStatus: '', phase: 'error', state: message });
    if (retryable && this.foreground && this.retries < 2) {
      this.retries++; this.patch({ phase: 'retrying', state: '화면에 다시 연결하고 있어요.' });
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.blocked = false; this.start(); }, 1500);
    }
  }
  reconnect = () => { if (this.disposed) return; this.retries = 0; this.blocked = false; this.stop(); if (this.foreground) this.start(); };
  release = () => this.revoke();
  suspend = () => { this.configure({ foreground: false, visible: this.wanted, controlAllowed: false }); };
  dispose = () => { this.foreground = false; this.disposed = true; this.stop(); this.listeners.clear(); this.revocations.clear(); };
}
