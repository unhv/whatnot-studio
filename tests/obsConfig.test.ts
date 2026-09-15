import { describe, expect, it } from "vitest";
import {
  obsWebsocketConfigFromRead,
  parseObsWebsocketConfig,
} from "../src/obs/obsConfig.js";

const FAKE_PASSWORD = "test-obs-websocket-password-not-real";

const realisticConfig = {
  alerts_enabled: false,
  auth_required: true,
  first_load: false,
  server_enabled: true,
  server_password: FAKE_PASSWORD,
  server_port: 4455,
};

describe("parseObsWebsocketConfig", () => {
  it("parses a realistic obs-websocket config.json", () => {
    const parsed = parseObsWebsocketConfig(JSON.stringify(realisticConfig));
    expect(parsed).toEqual({
      reason: "ok",
      serverEnabled: true,
      serverPort: 4455,
      authRequired: true,
      serverPassword: FAKE_PASSWORD,
    });
  });

  it("treats a disabled server as its own reason, not a throw", () => {
    const parsed = parseObsWebsocketConfig(
      JSON.stringify({ ...realisticConfig, server_enabled: false })
    );
    expect(parsed.reason).toBe("server-disabled");
    if (parsed.reason === "server-disabled") {
      expect(parsed.serverEnabled).toBe(false);
      expect(parsed.serverPort).toBe(4455);
    }
  });

  it("returns malformed for broken JSON without throwing", () => {
    expect(parseObsWebsocketConfig("{ not json")).toEqual({ reason: "malformed" });
    expect(parseObsWebsocketConfig("[]")).toEqual({ reason: "malformed" });
    expect(parseObsWebsocketConfig("null")).toEqual({ reason: "malformed" });
  });
});

describe("obsWebsocketConfigFromRead", () => {
  it("maps a missing file, a malformed file, and a disabled server to their own reasons", () => {
    expect(obsWebsocketConfigFromRead({ ok: false, code: "ENOENT" })).toEqual({
      reason: "missing-file",
    });
    expect(obsWebsocketConfigFromRead({ ok: true, text: "{ nope" })).toEqual({
      reason: "malformed",
    });
    expect(
      obsWebsocketConfigFromRead({
        ok: true,
        text: JSON.stringify({ ...realisticConfig, server_enabled: false }),
      }).reason
    ).toBe("server-disabled");
  });

  it("does not throw for any of those outcomes", () => {
    expect(() => obsWebsocketConfigFromRead({ ok: false, code: "ENOENT" })).not.toThrow();
    expect(() => obsWebsocketConfigFromRead({ ok: true, text: "{{{ " })).not.toThrow();
    expect(() =>
      obsWebsocketConfigFromRead({
        ok: true,
        text: JSON.stringify({ server_enabled: false, server_port: 4455 }),
      })
    ).not.toThrow();
  });
});
