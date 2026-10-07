import { panelTransition } from './panel-transition';
import { ReaderSession } from './native-reader-protocol';
import type { ReaderModeValue, ReaderPacket, ReaderReplyValue, ReaderSnapshotValue } from './native-reader-protocol';
import type { ReaderAnchor, ReaderDOM } from './native-reader-dom';
export type ReaderInput = Readonly<{
  scope: string; selected: boolean; hydrated: boolean; suspended: boolean; cursor: number | null;
  sourceKey: string; sourceId: string | null; arrived: boolean;
}>;
type SavedReader = { anchor: ReaderAnchor | null; mode: ReaderModeValue; unread: boolean; cursor: number | null };
type ReaderSink = Readonly<{ active: (value: boolean) => void; unread: (value: boolean) => void; awayFromLatest: (value: boolean) => void; error?: (message: string) => void; fallback?: () => void }>;
type LatestIntent = {
  navigation: number; interaction: number; width: number; attempts: number;
  keyboardObserved: boolean; inFlight: boolean; result: Promise<boolean>;
  finish: (accepted: boolean) => void; timeout: ReturnType<typeof setTimeout>;
};
export class RootReaderAdapter {
  readonly session: ReaderSession;
  private input: ReaderInput | undefined;
  private memory = new Map<string, SavedReader>();
  private key = '';
  private anchor: ReaderAnchor | null = null;
  private mode: ReaderModeValue = 'follow';
  private unread = false;
  private awayFromLatest = false;
  private sourcePending = false;
  private sourceCancelled = false;
  private priorInteraction = -1;
  private awaitingUserSettle = false;
  private attempted = new Set<string>();
  private binding = '';
  private bindingGeneration = 0;
  private enabled = false;
  private failed = false;
  private latestIntent: LatestIntent | undefined;
  constructor(private readonly dom: ReaderDOM, transport: (packet: ReaderPacket) => Promise<ReaderReplyValue>, private readonly sink: ReaderSink) {
    this.session = new ReaderSession(transport, (snapshot, external) => this.onSnapshot(snapshot, external));
  }
  private setUnread(value: boolean) { if (this.unread !== value) { this.unread = value; this.sink.unread(value); } }
  private setAwayFromLatest(value: boolean) {
    if (this.awayFromLatest !== value) { this.awayFromLatest = value; this.sink.awayFromLatest(value); }
  }
  private save() {
    if (!this.input?.selected) return;
    this.memory.delete(this.input.scope);
    this.memory.set(this.input.scope, { anchor: this.anchor, mode: this.mode, unread: this.unread, cursor: this.input.cursor });
    const oldest = this.memory.keys().next().value;
    if (this.memory.size > 20 && oldest) this.memory.delete(oldest);
  }
  configure(input: ReaderInput) {
    if (this.failed) return;
    if (!input.selected || input.suspended || `${input.scope}:${input.sourceKey}` !== this.key) this.setAwayFromLatest(false);
    if (!input.selected || input.suspended || `${input.scope}:${input.sourceKey}` !== this.key) this.finishLatest(false);
    if (!input.selected) {
      this.save(); this.input = input; this.session.release();
      this.key = ''; this.binding = ''; this.enabled = false; this.sink.active(false); return;
    }
    const key = `${input.scope}:${input.sourceKey}`;
    const changed = key !== this.key;
    if (changed) {
      this.save();
      const saved = this.memory.get(input.scope);
      this.key = key; this.anchor = saved?.anchor ?? null;
      this.mode = input.sourceKey ? 'source' : saved?.mode === 'source' ? 'reading' : saved?.mode ?? 'follow';
      this.sourcePending = Boolean(input.sourceKey); this.sourceCancelled = false;
      this.attempted.clear(); this.priorInteraction = -1; this.awaitingUserSettle = false;
      this.setUnread(Boolean(saved?.unread || (saved?.cursor !== null && saved?.cursor !== undefined && input.cursor !== null && input.cursor > saved.cursor)));
    }
    this.input = input;
    if (input.arrived && this.mode !== 'follow') this.setUnread(true);
    const binding = `${key}:${input.suspended}`;
    if (binding !== this.binding) {
      this.binding = binding;
      const generation = ++this.bindingGeneration;
      const request = this.session.bind({ key, scope: input.scope, mode: this.mode, suspended: input.suspended });
      const navigation = this.session.navigation;
      void request.then(reply => {
        if (navigation !== this.session.navigation || generation !== this.bindingGeneration || this.failed) return;
        if (!reply.ok || !reply.snapshot) { if (reply.error === 'stale_interaction' && !changed) this.binding = ''; else this.fail(); return; }
        this.enabled = true; this.sink.active(true); this.checkpoint();
      }).catch(() => { if (navigation === this.session.navigation && generation === this.bindingGeneration) this.fail(); });
    } else if (this.enabled) this.checkpoint();
  }
  private onSnapshot(snapshot: ReaderSnapshotValue, external: boolean) {
    const changedInteraction = this.priorInteraction >= 0 && snapshot.interaction > this.priorInteraction;
    this.priorInteraction = snapshot.interaction;
    this.mode = snapshot.mode;
    const intent = this.latestIntent;
    if (intent) {
      intent.keyboardObserved ||= intent.inFlight && snapshot.keyboardMoving;
      if (!this.validLatest(intent, snapshot)) this.finishLatest(false);
    }
    if (changedInteraction) {
      this.anchor = null; this.sourcePending = false; this.sourceCancelled = true;
      this.awaitingUserSettle = true; this.attempted.clear();
    }
    if (snapshot.suspended || !this.input?.selected || this.input.suspended) { this.setAwayFromLatest(false); return; }
    if (snapshot.dragging || snapshot.keyboardMoving) return;
    const maximum = Math.max(0, snapshot.contentHeight - snapshot.height + (snapshot.bottomInset ?? 0));
    this.setAwayFromLatest(maximum - snapshot.offset >= 24);
    if (this.latestIntent) { this.advanceLatest(this.latestIntent); return; }
    if (this.mode === 'follow' && Math.abs(maximum - snapshot.offset) <= 1) this.setUnread(false);
    if (external && this.enabled) this.checkpoint();
  }
  checkpoint() {
    if (this.latestIntent) return;
    const state = this.session.snapshot, input = this.input;
    if (!this.enabled || !state || !input?.hydrated || input.suspended || state.suspended || state.keyboardMoving || state.dragging) return;
    const layout = this.dom.layout();
    // WebKit removes native content insets from its DOM viewport, while bounds stay physical.
    const viewportHeight = state.height - (state.bottomInset ?? 0);
    if (Math.abs(layout.width - state.width) > 1 || layout.height < viewportHeight - 1 || layout.height > state.height + 1
      || Math.abs(layout.contentHeight - state.contentHeight) > 1) return;
    if (this.awaitingUserSettle) {
      if (Math.abs(layout.offset - state.offset) > 1) return;
      this.anchor = this.mode === 'follow' ? null : this.dom.capture(state.headerHeight);
      this.awaitingUserSettle = false; this.save();
    }
    if (this.sourcePending && !this.sourceCancelled) {
      if (!input.sourceId) return;
      const target = this.dom.source(input.sourceId, state.headerHeight);
      if (!target) return;
      this.anchor = target;
    }
    if (this.mode !== 'follow' && !this.anchor) this.anchor = this.dom.capture(state.headerHeight);
    const maximum = Math.max(0, state.contentHeight - viewportHeight);
    const offset = this.mode === 'follow' ? maximum
      : Math.max(0, Math.min(maximum, this.anchor ? this.dom.target(this.anchor, state.headerHeight) : layout.offset));
    if (Math.abs(layout.offset - offset) <= 1 && Math.abs(state.offset - offset) <= 1) {
      if (this.sourcePending && this.anchor) { this.dom.highlight(this.anchor.id); this.sourcePending = false; }
      this.save();
      if (typeof window !== 'undefined') { panelTransition()?.sourceReady(state); panelTransition()?.complete('chat', state); }
      return;
    }
    const signature = JSON.stringify([this.session.navigation, state.interaction, state.geometry, layout.width, layout.height,
      layout.contentHeight, this.mode, this.anchor?.id, this.anchor?.offset, this.mode === 'follow' ? 0 : offset]);
    if (this.attempted.has(signature)) return;
    this.attempted.add(signature);
    if (this.attempted.size > 64) this.attempted.delete(this.attempted.values().next().value!);
    const navigation = this.session.navigation;
    void this.session.send({ kind: 'layout', interaction: state.interaction, geometry: state.geometry, width: layout.width, height: state.height,
      contentHeight: layout.contentHeight, mode: this.mode, ...(this.mode === 'follow' ? {} : { offset }) }).then(reply => {
      if (navigation !== this.session.navigation || this.session.snapshot?.interaction !== state.interaction) return;
      if (!reply.ok) {
        if (reply.error === 'stale_geometry') { this.checkpoint(); return; }
        if (reply.error === 'busy' || reply.error === 'geometry_pending') this.attempted.delete(signature);
        return;
      }
      if (this.session.snapshot?.geometry !== state.geometry) return;
      if (this.sourcePending && this.anchor) { this.dom.highlight(this.anchor.id); this.sourcePending = false; }
      this.save();
    }).catch(() => { if (navigation === this.session.navigation) this.fail(); });
  }
  latest(): Promise<boolean> {
    const state = this.session.snapshot;
    if (!this.enabled || !state || !this.input?.selected || this.input.suspended || state.dragging || state.suspended) return Promise.resolve(false);
    if (this.latestIntent) return this.latestIntent.result;
    let finish!: (accepted: boolean) => void;
    const result = new Promise<boolean>(resolve => { finish = resolve; });
    const intent: LatestIntent = { navigation: this.session.navigation, interaction: state.interaction, width: state.width,
      attempts: 0, keyboardObserved: state.keyboardMoving, inFlight: false, result, finish,
      timeout: setTimeout(() => { if (this.latestIntent === intent) this.finishLatest(false); }, 3000) };
    this.latestIntent = intent;
    this.advanceLatest(intent);
    return result;
  }
  private validLatest(intent: LatestIntent, state: ReaderSnapshotValue) {
    return this.enabled && this.input?.selected && !this.input.suspended && !state.suspended && !state.dragging
      && intent.navigation === this.session.navigation && intent.interaction === state.interaction
      && Math.abs(intent.width - state.width) <= 1;
  }
  private finishLatest(accepted: boolean) {
    const intent = this.latestIntent;
    if (!intent) return;
    this.latestIntent = undefined; clearTimeout(intent.timeout);
    if (accepted) {
      this.sourcePending = false; this.sourceCancelled = true; this.anchor = null; this.mode = 'follow';
      this.setUnread(false); this.setAwayFromLatest(false); this.save();
    }
    intent.finish(accepted);
  }
  private advanceLatest(intent: LatestIntent) {
    const state = this.session.snapshot;
    if (this.latestIntent !== intent || intent.inFlight) return;
    if (!state || !this.validLatest(intent, state)) { this.finishLatest(false); return; }
    if (state.keyboardMoving) { intent.keyboardObserved = true; return; }
    if (intent.attempts >= 2) { this.finishLatest(false); return; }
    intent.keyboardObserved = false;
    intent.inFlight = true; intent.attempts++;
    void this.session.send({ kind: 'move', interaction: state.interaction, geometry: state.geometry, mode: 'follow' }, () => this.latestIntent === intent).then(reply => {
      if (this.latestIntent !== intent) return;
      intent.inFlight = false;
      const current = this.session.snapshot;
      if (!current || !this.validLatest(intent, current)) { this.finishLatest(false); return; }
      if (reply.ok) { this.finishLatest(true); return; }
      // Only this explicit latest intent may cross its observed keyboard transition.
      // It issues a fresh geometry-fenced command once; stale absolute targets never replay.
      if (intent.attempts < 2 && intent.keyboardObserved && (reply.error === 'busy' || reply.error === 'stale_geometry')) {
        this.advanceLatest(intent); return;
      }
      this.finishLatest(false);
    }).catch(() => { if (this.latestIntent === intent) this.fail(); });
  }
  private fail() {
    if (this.failed) return;
    this.finishLatest(false);
    this.setAwayFromLatest(false);
    this.setUnread(false);
    this.anchor = null; this.mode = 'follow'; this.memory.clear();
    this.failed = true; this.enabled = false; this.session.dispose();
    this.sink.active(false);
    this.sink.fallback?.();
  }
  disable(_reportError = true) { this.fail(); }
  dispose() { this.setAwayFromLatest(false); this.finishLatest(false); this.save(); this.session.dispose(); this.enabled = false; this.sink.active(false); }
}
