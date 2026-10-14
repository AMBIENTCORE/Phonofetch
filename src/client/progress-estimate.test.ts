import { describe, expect, it } from "vitest";
import { observedRate, predictedProgress, type ProgressSample } from "./progress-estimate";

describe("visual transfer progress", () => {
  const previous: ProgressSample = { transferred: 100, sampledAt: 1000, rate: 20 };

  it("learns a rate only from successive advancing byte samples of a transfer", () => {
    expect(observedRate(null, 200, 6000)).toBe(0);
    expect(observedRate(previous, 100, 6000)).toBe(0);
    expect(observedRate(previous, 80, 6000)).toBe(0);
    expect(observedRate(previous, 200, 1000)).toBe(0);
    expect(observedRate(previous, 200, 1100)).toBe(0);
    expect(observedRate(previous, 200, 6000)).toBe(20);
    expect(observedRate(previous, 300, 6000)).toBe(30);
  });

  it("predicts only within a five-second horizon and never reaches completion", () => {
    const sample: ProgressSample = { transferred: 100, sampledAt: 6000, rate: 20 };
    expect(predictedProgress(sample, 400, 6000)).toBe(25);
    expect(predictedProgress(sample, 400, 8500)).toBe(37.5);
    expect(predictedProgress(sample, 400, 11000)).toBe(50);
    expect(predictedProgress(sample, 400, 16000)).toBe(50);
    expect(predictedProgress({ ...sample, rate: 1000 }, 400, 8500)).toBe(99.5);
    expect(predictedProgress(sample, 0, 8500)).toBe(0);
  });

  it("restarts from confirmed bytes when a new sample stalls or contradicts the estimate", () => {
    const sample: ProgressSample = { transferred: 100, sampledAt: 6000, rate: 20 };
    expect(predictedProgress(sample, 400, 8500)).toBe(37.5);
    const stalled: ProgressSample = { transferred: 100, sampledAt: 11000,
      rate: observedRate(sample, 100, 11000) };
    expect(predictedProgress(stalled, 400, 14000)).toBe(25);
    const slower: ProgressSample = { transferred: 110, sampledAt: 16000,
      rate: observedRate(stalled, 110, 16000) };
    expect(predictedProgress(slower, 400, 18000)).toBe(28.5);
  });
});
