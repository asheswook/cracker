import { z } from 'zod';
import { compatibleFeedGeometry, feedMotionElapsed, feedMotionFrames, predictFeedMotion } from './native-feed-motion-model';
import type { FeedGeometry, FeedPrediction } from './native-feed-motion-model';
const KeyboardTransition = z.object({
  version: z.literal(1), document: z.uuid(), session: z.uuid(), transition: z.uuid(),
  startTime: z.number().finite(), duration: z.number().positive().max(2000),
  curve: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(7)]),
  fromHeight: z.number().positive(), toHeight: z.number().positive(), width: z.number().positive(),
});
const curves = {
  0: 'cubic-bezier(.42,0,.58,1)', 1: 'cubic-bezier(.42,0,1,1)',
  2: 'cubic-bezier(0,0,.58,1)', 3: 'linear',
  // Public curve 7 has no documented CSS mapping; this is the existing UI approximation.
  7: 'cubic-bezier(.2,0,0,1)',
} as const;
type MotionContext = Readonly<{
  feed: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'clientWidth' | 'scrollHeight' | 'querySelector'>; eligible: () => boolean;
  identity: () => Readonly<{ document: string; session: string }> | undefined;
}>;
export class NativeFeedMotion {
  private context: MotionContext | undefined;
  private geometry: FeedGeometry | undefined;
  private prediction: FeedPrediction | undefined;
  private animation: Animation | undefined;
  private easing = 'linear';
  private transition = '';
  private canonical = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  connect(context: MotionContext): () => void {
    this.context = context;
    this.remember();
    window.addEventListener('assistant-native-keyboard-transition', this.receive);
    return () => {
      window.removeEventListener('assistant-native-keyboard-transition', this.receive);
      this.cancel();
      this.context = undefined;
    };
  }
  private measure(): FeedGeometry | undefined {
    const feed = this.context?.feed;
    return feed ? { top: feed.scrollTop, height: feed.clientHeight, width: feed.clientWidth, content: feed.scrollHeight } : undefined;
  }
  remember() { this.geometry = this.measure(); }
  cancelForInteraction() {
    const feed = this.context?.feed;
    const content = feed?.querySelector<HTMLElement>(':scope > .feed-motion-clip > .feed-content');
    if (feed && content && this.animation) {
      const transform = getComputedStyle(content).transform;
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      // One event-time correction preserves visual position when the scroll range permits it.
      feed.scrollTop = Math.max(0, Math.min(feed.scrollHeight - feed.clientHeight, feed.scrollTop - offset));
    }
    this.cancel();
    this.remember();
  }
  cancel() {
    clearTimeout(this.expiry);
    this.animation?.cancel();
    this.animation = undefined;
    this.prediction = undefined;
  }
  private receive = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = KeyboardTransition.safeParse(event.detail);
    const context = this.context;
    const before = this.geometry;
    if (!parsed.success || !context || !before) return;
    const detail = parsed.data;
    const identity = context.identity();
    if (detail.document !== identity?.document || detail.session !== identity.session || detail.transition === this.transition) return;
    if (!context.eligible() || Math.abs(detail.width - window.innerWidth) > 1 || before.width !== context.feed.clientWidth || (window.visualViewport?.scale ?? 1) !== 1) {
      this.cancel(); return;
    }
    if (Math.abs(window.innerHeight - detail.fromHeight) > 2 || Math.abs(window.innerHeight - detail.toHeight) <= 1) return;
    if (Date.now() - detail.startTime >= detail.duration || detail.startTime > Date.now() + 100) return;
    const content = context.feed.querySelector<HTMLElement>(':scope > .feed-motion-clip > .feed-content');
    if (!content) return;
    const matrix = getComputedStyle(content).transform;
    const offset = matrix === 'none' ? 0 : new DOMMatrixReadOnly(matrix).m42;
    this.cancel();
    this.transition = detail.transition;
    this.canonical = false;
    this.prediction = predictFeedMotion(before, detail, offset);
    this.easing = curves[detail.curve];
    this.animate(before.top);
    this.expiry = setTimeout(() => this.cancel(), Math.max(0, detail.duration - (Date.now() - detail.startTime)) + 250);
  };
  /** Called after the existing ResizeObserver has performed its canonical scroll correction. */
  rebase() {
    const after = this.measure();
    const prediction = this.prediction;
    if (prediction && after) {
      if (!this.context?.eligible() || !compatibleFeedGeometry(prediction, after)) this.cancel();
      else if (after.height !== prediction.before.height) {
        this.canonical = true;
        this.animate(after.top);
      }
    }
    this.geometry = after;
  }
  private animate(canonicalTop: number) {
    const prediction = this.prediction;
    const content = this.context?.feed.querySelector<HTMLElement>(':scope > .feed-motion-clip > .feed-content');
    if (!prediction || !content) return;
    const elapsed = feedMotionElapsed(prediction, Date.now());
    this.animation?.cancel();
    if (elapsed >= prediction.duration && this.canonical) { this.cancel(); return; }
    const [from, to] = feedMotionFrames(prediction, canonicalTop);
    const animation = content.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }], {
      duration: prediction.duration, easing: this.easing, fill: 'both',
    });
    animation.currentTime = elapsed;
    this.animation = animation;
    animation.onfinish = () => {
      if (this.animation === animation && this.canonical) this.cancel();
    };
  }
}
