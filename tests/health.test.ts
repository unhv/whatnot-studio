import { describe, expect, it } from "vitest";
import {
  foldHealth,
  HEALTH_MACHINE,
  HEALTH_NETWORK,
  initialHealthState,
  type HealthSample,
} from "../src/obs/health.js";

function sample(partial: Partial<HealthSample>): HealthSample {
  return {
    outputSkippedFrames: 0,
    outputBytes: 0,
    renderSkippedFrames: 0,
    cpuUsage: 10,
    reconnecting: false,
    live: true,
    ...partial,
  };
}

describe("live health indicator", () => {
  it("does not warn on a single bad sample", () => {
    let state = initialHealthState(0, 0);
    state = foldHealth(state, sample({ outputBytes: 1000 }), 1000);
    state = foldHealth(
      state,
      sample({ outputSkippedFrames: 50, outputBytes: 1000, outputCongestion: 1 }),
      5000
    );
    expect(state.warning).toBeNull();
  });

  it("reports network trouble from skipped output frames, reconnecting, or stalled bytes — not congestion", () => {
    let state = initialHealthState(0, 0);
    state = foldHealth(state, sample({ outputBytes: 5000, outputSkippedFrames: 0 }), 1000);
    state = foldHealth(state, sample({ outputBytes: 5000, outputSkippedFrames: 20, outputCongestion: 1 }), 5000);
    state = foldHealth(state, sample({ outputBytes: 5000, outputSkippedFrames: 40, outputCongestion: 1 }), 9000);
    expect(state.warning).toEqual({ kind: "network", message: HEALTH_NETWORK });

    let congestionOnly = initialHealthState(0, 0);
    congestionOnly = foldHealth(congestionOnly, sample({ outputBytes: 1000, outputCongestion: 1 }), 1000);
    congestionOnly = foldHealth(
      congestionOnly,
      sample({ outputBytes: 8000, outputSkippedFrames: 0, outputCongestion: 1 }),
      5000
    );
    congestionOnly = foldHealth(
      congestionOnly,
      sample({ outputBytes: 16000, outputSkippedFrames: 0, outputCongestion: 1 }),
      9000
    );
    expect(congestionOnly.warning).toBeNull();

    let reconnecting = initialHealthState(0, 0);
    reconnecting = foldHealth(reconnecting, sample({ reconnecting: true, outputBytes: 100 }), 1000);
    reconnecting = foldHealth(reconnecting, sample({ reconnecting: true, outputBytes: 100 }), 5000);
    expect(reconnecting.warning?.kind).toBe("network");
  });

  it("reports machine trouble from climbing render skips with high CPU, after warmup", () => {
    let cold = initialHealthState(0, 15_000);
    cold = foldHealth(cold, sample({ renderSkippedFrames: 0, cpuUsage: 90 }), 1000);
    cold = foldHealth(cold, sample({ renderSkippedFrames: 40, cpuUsage: 92 }), 5000);
    cold = foldHealth(cold, sample({ renderSkippedFrames: 80, cpuUsage: 95 }), 9000);
    expect(cold.warning).toBeNull();

    let warm = initialHealthState(0, 0);
    warm = foldHealth(warm, sample({ renderSkippedFrames: 0, cpuUsage: 90, outputBytes: 1000 }), 20_000);
    warm = foldHealth(warm, sample({ renderSkippedFrames: 40, cpuUsage: 92, outputBytes: 8000 }), 24_000);
    warm = foldHealth(warm, sample({ renderSkippedFrames: 80, cpuUsage: 95, outputBytes: 16000 }), 28_000);
    expect(warm.warning).toEqual({ kind: "machine", message: HEALTH_MACHINE });
  });

  it("does not collapse network and machine into one fault", () => {
    expect(HEALTH_NETWORK).not.toBe(HEALTH_MACHINE);
    expect(HEALTH_NETWORK.toLowerCase()).toMatch(/internet/);
    expect(HEALTH_MACHINE.toLowerCase()).toMatch(/computer/);
  });
});
