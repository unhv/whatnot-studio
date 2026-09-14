import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureWebsocketServerEnabled = vi.fn(async () => {});

vi.mock("../spike/obs-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spike/obs-launcher.js")>();
  return {
    ...actual,
    ensureWebsocketServerEnabled,
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ pid: 4242 })),
}));

describe("launchObsForProductAsync", () => {
  beforeEach(() => {
    ensureWebsocketServerEnabled.mockClear();
  });

  it("ensures the websocket server is enabled before spawning OBS", async () => {
    // MEASURED 2026-09-15 (FINDINGS.md): obs-websocket's persisted config can
    // have server_enabled:false, and the --websocket_* CLI flags only
    // override values, never flip that switch -- without this call the
    // websocket never opens on a real machine, silently.
    const { launchObsForProductAsync } = await import("../src/obs/launch.js");
    const result = await launchObsForProductAsync({ port: 4455, password: "x" });
    expect(ensureWebsocketServerEnabled).toHaveBeenCalledTimes(1);
    expect(result.pid).toBe(4242);
  });
});
