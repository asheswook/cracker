import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';

type Request = { readonly name: string; readonly arguments: string };
type Action = { readonly kind: 'click'; readonly x: number; readonly y: number }
  | { readonly kind: 'request'; readonly digest: string } | { readonly kind: 'editing' };
type Frame = { readonly digest: string; readonly pixels: Buffer; readonly width: number; readonly height: number; readonly action: Action | undefined };
export type VisualAdvisory = {
  readonly kind: 'same-action-view' | 'visual-cycle';
  readonly observations: number;
  readonly period: number;
  readonly message: string;
};
const Args = z.object({ code: z.string().optional(), action: z.string().optional(), x: z.number().optional(), y: z.number().optional() });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function actionOf(request?: Request): Action | undefined {
  if (!request) return undefined;
  let value: unknown;
  try { value = JSON.parse(request.arguments); } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  const parsed = Args.safeParse(value);
  if (!parsed.success) return undefined;
  const args = parsed.data;
  if (request.name === 'computer') {
    if (args.action === 'type' || args.action === 'key') return { kind: 'editing' };
    if (args.action === 'click' && args.x !== undefined && args.y !== undefined) return { kind: 'click', x: args.x, y: args.y };
    if (args.action === 'screenshot' || args.action === 'move') return undefined;
  }
  if (args.code !== undefined) {
    if (/desktop\s*\.\s*(type|key)\s*\(/.test(args.code)) return { kind: 'editing' };
    const clicks = [...args.code.matchAll(/desktop\s*\.\s*click\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)];
    if (clicks.length === 1 && !/desktop\s*\.\s*(drag|scroll)\s*\(/.test(args.code)) {
      const click = clicks[0];
      if (click?.[1] && click[2]) return { kind: 'click', x: Number(click[1]), y: Number(click[2]) };
    }
    if (!/desktop\s*\.\s*(click|drag|scroll)\s*\(/.test(args.code)) return undefined;
  }
  return { kind: 'request', digest: digest(request.name + ':' + request.arguments) };
}
function sameAction(a: Action | undefined, b: Action | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'editing' || b.kind === 'editing') return false;
  if (a.kind === 'click' && b.kind === 'click') return Math.hypot(a.x - b.x, a.y - b.y) <= 16;
  return a.kind === 'request' && b.kind === 'request' && a.digest === b.digest;
}
function similar(a: Frame, b: Frame): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.digest === b.digest) return true;
  let changed = 0, total = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const difference = Math.abs((a.pixels[i] ?? 0) - (b.pixels[i] ?? 0));
    total += difference;
    if (difference > 24) changed++;
  }
  return changed / a.pixels.length <= 0.02 && total / a.pixels.length <= 3;
}

export class VisualProgress {
  private frames: Frame[] = [];
  private hinted: Frame[] = [];
  private novel = 0;
  private pending: Action | undefined;

  reset(): void { this.frames = []; this.hinted = []; this.novel = 0; this.pending = undefined; }

  async observe(images: readonly string[], request?: Request): Promise<VisualAdvisory | undefined> {
    const action = actionOf(request);
    if (action) this.pending = action;
    const last = images.at(-1);
    if (!last || !last.startsWith('data:image/png;base64,') || last.length > 12 * 1024 * 1024) return undefined;
    let frame: Frame;
    try {
      const image = sharp(Buffer.from(last.slice(22), 'base64'), { limitInputPixels: 16 * 1024 * 1024 });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) return undefined;
      const pixels = await image.resize(64, 48, { fit: 'fill' }).removeAlpha().greyscale().raw().timeout({ seconds: 1 }).toBuffer();
      frame = { digest: digest(last), pixels, width: metadata.width, height: metadata.height, action: this.pending };
    } catch (error) {
      if (error instanceof Error) return undefined;
      throw error;
    }
    this.pending = undefined;
    this.frames.push(frame);
    this.frames = this.frames.slice(-12);
    if (this.hinted.length) {
      this.novel = this.hinted.some(prior => similar(prior, frame)) ? 0 : this.novel + 1;
      if (this.novel >= 3) { this.hinted = []; this.novel = 0; }
    }
    if (frame.action?.kind === 'editing' || this.hinted.length) return undefined;
    const same = this.frames.filter(prior => similar(prior, frame) && sameAction(prior.action, frame.action));
    if (frame.action && same.length >= 4) return this.note('same-action-view', same, 1);
    for (let period = 1; period <= 4; period++) {
      const count = Math.max(6, period * 3), recent = this.frames.slice(-count);
      if (recent.length < count) continue;
      if (recent.every((item, index) => {
        const prior = recent[index % period];
        return prior !== undefined && item.action?.kind !== 'editing' && similar(item, prior) && sameAction(item.action, prior.action);
      })) return this.note('visual-cycle', recent, period);
    }
    return undefined;
  }

  private note(kind: VisualAdvisory['kind'], frames: readonly Frame[], period: number): VisualAdvisory {
    this.hinted = [...frames];
    const finding = kind === 'same-action-view'
      ? `${frames.length} completed computer requests revisit a similar view with the same requested action or click region.`
      : `${frames.length} final computer observations repeat a ${period}-view cycle with matching requested actions.`;
    return { kind, observations: frames.length, period, message:
      `Desktop navigation checkpoint: ${finding} Thumbnail similarity tolerates small changes such as cursors and clocks; it does not prove failure or exclude a meaningful local change. Before another repetition, retain the user's objective and already verified findings in a brief working checkpoint, identify the specific expected change and compare it with the current full-resolution screenshot. If that change is absent, choose one different authorized route: verify the active window/focus/target, use an available direct link or search, or inspect the same VM through shell/files. If a page is still loading, wait once and inspect a fresh frame. Do not restart completed work or replay a possibly completed submission. These are observations, not a stop instruction; continue toward the remaining objective.` };
  }
}
