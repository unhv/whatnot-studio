import { describe, expect, it } from "vitest";
import { runUploadProbe } from "../electron/uploadProbe.js";

function okResponse(): Response {
  return { ok: true } as Response;
}

/** Fake monotonic clock: each `now()` call jumps a fixed step. */
function steppingClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}

/**
 * Timeout sleep that never fires. `runUploadProbe` races this against the
 * upload loop; a pending Promise with no timer does not pin the event loop.
 */
function sleepWithoutFiring(): Promise<void> {
  return new Promise(() => {});
}

describe("upload probe", () => {
  it("returns ok with sustained kbps and loaded rtt from a healthy fake link", async () => {
    const chunkBytes = 75_000;
    const clockStepMs = 1_000;
    let bytes = 0;
    const result = await runUploadProbe({
      now: steppingClock(clockStepMs),
      // Clock units, not wall time. Four rounds × six now() calls each
      // (after start) stay under 25s; sleep never fires the timeout.
      durationMs: 25_000,
      timeoutMs: 40_000,
      maxRounds: 4,
      chunkBytes,
      sleep: sleepWithoutFiring,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("__up")) {
          bytes += chunkBytes;
        }
        return okResponse();
      },
    });
    // Per round: 2 loop-guard now()s, ping t0, upload cache-bust, ping rtt,
    // sample. Samples land at 6s, 12s, 18s, 24s — all past slow-start.
    // Each window is 75_000 bytes over 6000ms → 100 kbps.
    expect(result.outcome).toBe("ok");
    expect(result.sustainedKbps).toBe(100);
    expect(result.loadedRttMs).toBe(2_000);
    expect(bytes).toBe(chunkBytes * 4);
  });

  it("returns failed when every sample stays inside slow-start", async () => {
    const chunkBytes = 75_000;
    // 50ms steps × 4 rounds keep samples at 300/600/900/1200ms, all < 2s.
    const result = await runUploadProbe({
      now: steppingClock(50),
      durationMs: 25_000,
      timeoutMs: 40_000,
      maxRounds: 4,
      chunkBytes,
      sleep: sleepWithoutFiring,
      fetchImpl: async () => okResponse(),
    });
    expect(result.outcome).toBe("failed");
    expect(result.sustainedKbps).toBeNull();
  });

  it("returns failed when the upload rejects", async () => {
    const result = await runUploadProbe({
      durationMs: 20,
      timeoutMs: 50,
      maxRounds: 2,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(result.outcome).toBe("failed");
    expect(result.sustainedKbps).toBeNull();
  });

  it("returns timeout when the request never settles", async () => {
    const result = await runUploadProbe({
      durationMs: 20,
      timeoutMs: 30,
      maxRounds: 8,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30))),
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return okResponse();
      },
    });
    expect(result.outcome).toBe("timeout");
    expect(result.sustainedKbps).toBeNull();
  });
});
