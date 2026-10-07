export type FeedGeometry = Readonly<{ top: number; height: number; width: number; content: number }>;
export type FeedPrediction = Readonly<{
  before: FeedGeometry; predictedDelta: number; initialOffset: number; startTime: number; duration: number;
}>;
export function predictFeedMotion(before: FeedGeometry, transition: Readonly<{
  fromHeight: number; toHeight: number; startTime: number; duration: number;
}>, initialOffset: number): FeedPrediction {
  const height = Math.max(1, before.height + transition.toHeight - transition.fromHeight);
  const targetTop = Math.max(0, before.content - height);
  return { before, predictedDelta: targetTop - before.top, initialOffset,
    startTime: transition.startTime, duration: transition.duration };
}
export function feedMotionFrames(prediction: FeedPrediction, canonicalTop: number): readonly [number, number] {
  const actualDelta = canonicalTop - prediction.before.top;
  return [prediction.initialOffset + actualDelta, actualDelta - prediction.predictedDelta];
}
export function compatibleFeedGeometry(prediction: FeedPrediction, geometry: FeedGeometry): boolean {
  return prediction.before.width === geometry.width && prediction.before.content === geometry.content;
}
export function feedMotionElapsed(prediction: FeedPrediction, now: number): number {
  return Math.max(0, now - prediction.startTime);
}
