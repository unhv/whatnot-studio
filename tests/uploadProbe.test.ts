import { describe, expect, it } from "vitest";
import { runUploadProbe } from "../electron/uploadProbe.js";

function okResponse(): Response {
  return { ok: true } as Response;
}

describe("upload probe", () => {
  it("returns ok with sustained kbps and loaded rtt from a healthy fake link", async () => {
    let bytes = 0;
    const result = await runUploadProbe({
      durationMs: 50,
      timeoutMs: 200,
      maxRounds: 4,
      chunkBytes: 50_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("__up")) {
          bytes += 50_000;
          return okResponse();
        }
        await new Promise((r) => setTimeout(r, 5));
        return okResponse();
      },
    });
    expect(result.outcome).toBe("ok");
    expect(result.sustainedKbps).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(0);
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
