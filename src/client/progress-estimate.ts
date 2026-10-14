export type ProgressSample = { transferred: number; sampledAt: number; rate: number };

export function observedRate(previous: ProgressSample | null, transferred: number, sampledAt: number): number {
  if (!previous || transferred <= previous.transferred || sampledAt - previous.sampledAt < 500) return 0;
  const rate = (transferred - previous.transferred) * 1000 / (sampledAt - previous.sampledAt);
  return previous.rate > 0 ? (previous.rate + rate) / 2 : rate;
}

export function predictedProgress(sample: ProgressSample, size: number, now: number): number {
  if (size <= 0) return 0;
  const elapsed = Math.max(0, Math.min(now - sample.sampledAt, 5000));
  const bytes = sample.transferred + sample.rate * elapsed / 1000;
  return Math.max(0, Math.min(99.5, bytes * 100 / size));
}
