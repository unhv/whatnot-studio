import { describe, it, expect } from "vitest";
import { deriveLiveState, elapsedMs, initialLiveState } from "../src/obs/liveMode.js";

describe("deriveLiveState", () => {
  it("flips to live on outputActive: true", () => {
    const state = deriveLiveState({ outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" }, 5000);
    expect(state.live).toBe(true);
    expect(state.since).toBe(5000);
  });

  it("flips to not-live on outputActive: false", () => {
    const state = deriveLiveState({ outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" }, 7000);
    expect(state.live).toBe(false);
  });

  it("starts not-live", () => {
    expect(initialLiveState(0).live).toBe(false);
  });
});

describe("elapsedMs", () => {
  it("counts up from `since`", () => {
    const state = deriveLiveState({ outputActive: true, outputState: "x" }, 1000);
    expect(elapsedMs(state, 4500)).toBe(3500);
  });

  it("never goes negative", () => {
    const state = deriveLiveState({ outputActive: true, outputState: "x" }, 1000);
    expect(elapsedMs(state, 500)).toBe(0);
  });
});
