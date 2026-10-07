import { describe, expect, test } from 'bun:test';
import { compatibleFeedGeometry, feedMotionElapsed, feedMotionFrames, predictFeedMotion } from '../src/native-feed-motion-model';
const closed = { top: 1400, height: 600, width: 390, content: 2000 };
describe('predictive native feed geometry', () => {
  test('opening begins before canonical resize then rebases to zero at the same endpoint', () => {
    const p = predictFeedMotion(closed, { fromHeight: 700, toHeight: 400, startTime: 1000, duration: 350 }, 0);
    expect(p.predictedDelta).toBe(300);
    expect(feedMotionFrames(p, closed.top)).toEqual([0, -300]);
    expect(feedMotionFrames(p, 1700)).toEqual([300, 0]);
    expect(feedMotionElapsed(p, 1140)).toBe(140);
  });
  test('closing uses cached old top even when browser already clamped scrollTop before RO', () => {
    const opened = { ...closed, height: 300, top: 1700 };
    const p = predictFeedMotion(opened, { fromHeight: 400, toHeight: 700, startTime: 1000, duration: 350 }, 0);
    expect(feedMotionFrames(p, opened.top)).toEqual([0, 300]);
    expect(feedMotionFrames(p, 1400)).toEqual([-300, 0]);
    expect(p.before.top).toBe(1700);
  });
  test('rebasing preserves screen-space continuity for any timing progress', () => {
    const p = predictFeedMotion(closed, { fromHeight: 700, toHeight: 400, startTime: 0, duration: 350 }, 0);
    const before = feedMotionFrames(p, 1400), after = feedMotionFrames(p, 1700);
    for (const progress of [0, 0.1, 0.25, 0.7, 1]) {
      const oldScreen = -1400 + before[0] * (1 - progress) + before[1] * progress;
      const newScreen = -1700 + after[0] * (1 - progress) + after[1] * progress;
      expect(newScreen).toBeCloseTo(oldScreen, 8);
    }
  });
  test('interruption starts from sampled presentation offset without moving header or scroll position', () => {
    const p = predictFeedMotion(closed, { fromHeight: 700, toHeight: 500, startTime: 1000, duration: 300 }, -42);
    expect(feedMotionFrames(p, 1400)).toEqual([-42, -200]);
    expect(feedMotionFrames(p, 1600)).toEqual([158, 0]);
    expect(closed.top).toBe(1400);
  });
  test('content arrival or width change invalidates prediction, viewport height change does not', () => {
    const p = predictFeedMotion(closed, { fromHeight: 700, toHeight: 400, startTime: 1000, duration: 350 }, 0);
    expect(compatibleFeedGeometry(p, { ...closed, content: 2050 })).toBe(false);
    expect(compatibleFeedGeometry(p, { ...closed, width: 393 })).toBe(false);
    expect(compatibleFeedGeometry(p, { ...closed, height: 300, top: 1700 })).toBe(true);
  });
  test('short content clamps predicted final scroll top at zero', () => {
    const p = predictFeedMotion({ ...closed, height: 300, content: 200, top: 0 },
      { fromHeight: 400, toHeight: 700, startTime: 1000, duration: 350 }, 0);
    expect(p.predictedDelta).toBe(0);
    expect(feedMotionFrames(p, 0)).toEqual([0, 0]);
  });
  test('delayed event uses elapsed original timeline, never a fresh full duration', () => {
    const p = predictFeedMotion(closed, { fromHeight: 700, toHeight: 400, startTime: 1000, duration: 350 }, 0);
    expect(feedMotionElapsed(p, 1270)).toBe(270);
    expect(feedMotionElapsed(p, 1400)).toBeGreaterThanOrEqual(p.duration);
  });
});
