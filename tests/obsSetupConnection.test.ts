import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyObsConnectError,
  connectUsingObsConfig,
  startObsSetupSession,
  type ObsClient,
} from "../src/obs/client.js";
import { parseObsWebsocketConfig, type ObsWebsocketConfig } from "../src/obs/obsConfig.js";
import {
  deviceEnumFromAttempt,
  setupDeviceBanner,
  setupDeviceKind,
  SETUP_COPY_OBS_PASSWORD_HINT,
  SETUP_NO_CAMERAS,
  SETUP_OBS_AUTH_FAILED,
  SETUP_OBS_NOT_CONNECTED,
  SETUP_OBS_SERVER_DISABLED,
  SETUP_OBS_SERVER_DISABLED_HINT,
  SETUP_OBS_WRONG_PORT,
  SETUP_SHOW_TOOLS_HINT,
} from "../src/state/setupDevices.js";
import { DEFAULT_SHOW_CONFIG, persistableShowConfig, useAppStore } from "../src/state/store.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_PASSWORD = "test-obs-websocket-password-not-real";

const enabledConfig: ObsWebsocketConfig = {
  reason: "ok",
  serverEnabled: true,
  serverPort: 4455,
  authRequired: true,
  serverPassword: FAKE_PASSWORD,
};

function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out"));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

describe("classifyObsConnectError", () => {
  it("treats authentication failure as auth-failed, not not-running", () => {
    expect(classifyObsConnectError(Object.assign(new Error("Authentication failed."), { code: 4009 }))).toBe(
      "auth-failed"
    );
    expect(classifyObsConnectError(new Error("Failed to authenticate"))).toBe("auth-failed");
    expect(classifyObsConnectError(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(
      "not-running"
    );
    expect(classifyObsConnectError(Object.assign(new Error("non-compatible server"), { code: -1 }))).toBe(
      "wrong-port"
    );
  });
});

describe("connectUsingObsConfig", () => {
  it("does not connect when the websocket server is disabled", async () => {
    const client = new FakeObsClient();
    const result = await connectUsingObsConfig(client, {
      reason: "server-disabled",
      serverEnabled: false,
      serverPort: 4455,
      authRequired: true,
      serverPassword: FAKE_PASSWORD,
    });
    expect(result).toEqual({ ok: false, reason: "server-disabled" });
    expect(client.connectCalls).toBe(0);
  });

  it("connects with the password OBS's own config has", async () => {
    const seen: { url?: string; password?: string } = {};
    const client: ObsClient = {
      async connect(url, password) {
        seen.url = url;
        seen.password = password;
      },
      async disconnect() {},
      async call() {
        throw new Error("unused");
      },
      on() {},
      off() {},
    };
    const result = await connectUsingObsConfig(client, enabledConfig);
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ url: "ws://127.0.0.1:4455", password: FAKE_PASSWORD });
  });

  it("reports auth-failed when OBS rejects the password", async () => {
    const client = new FakeObsClient();
    client.connect = async () => {
      client.connectCalls += 1;
      throw Object.assign(new Error("Authentication failed."), { code: 4009 });
    };
    const result = await connectUsingObsConfig(client, enabledConfig);
    expect(result).toEqual({ ok: false, reason: "auth-failed" });
  });
});

describe("the five setup states each have their own message", () => {
  it("renders a distinct sentence for each of the five situations", () => {
    const notRunning = setupDeviceBanner({ connected: false, video: [], audio: [], connectReason: "not-running" });
    const serverOff = setupDeviceBanner({
      connected: false,
      video: [],
      audio: [],
      connectReason: "server-disabled",
    });
    const auth = setupDeviceBanner({ connected: false, video: [], audio: [], connectReason: "auth-failed" });
    const wrongPort = setupDeviceBanner({ connected: false, video: [], audio: [], connectReason: "wrong-port" });
    const noCameras = setupDeviceBanner({ connected: true, video: [], audio: [] });

    expect(setupDeviceKind({ connected: false, video: [], audio: [], connectReason: "not-running" })).toBe(
      "not-connected"
    );
    expect(notRunning?.title).toBe(SETUP_OBS_NOT_CONNECTED);
    expect(serverOff?.title).toBe(SETUP_OBS_SERVER_DISABLED);
    expect(serverOff?.body).toBe(SETUP_OBS_SERVER_DISABLED_HINT);
    expect(serverOff?.body).toMatch(/Tools -> WebSocket Server Settings/);
    expect(serverOff?.body).toMatch(/Enable/);
    expect(auth?.title).toBe(SETUP_OBS_AUTH_FAILED);
    expect(wrongPort?.title).toBe(SETUP_OBS_WRONG_PORT);
    expect(noCameras?.title).toBe(SETUP_NO_CAMERAS);

    const titles = [notRunning?.title, serverOff?.title, auth?.title, wrongPort?.title, noCameras?.title];
    expect(new Set(titles).size).toBe(5);

    expect(auth?.title).not.toBe(SETUP_OBS_NOT_CONNECTED);
    expect(auth?.title).not.toMatch(/OBS is not running/i);
    expect(serverOff?.title).not.toBe(SETUP_OBS_NOT_CONNECTED);
    expect(wrongPort?.title).not.toBe(SETUP_OBS_NOT_CONNECTED);
  });

  it("maps an auth-failed attempt onto the auth banner, not the not-running banner", () => {
    const state = deviceEnumFromAttempt({ ok: false, reason: "auth-failed" });
    expect(setupDeviceKind(state)).toBe("auth-failed");
    expect(setupDeviceBanner(state)?.title).toBe(SETUP_OBS_AUTH_FAILED);
    expect(setupDeviceBanner(state)?.title).not.toBe(SETUP_OBS_NOT_CONNECTED);
  });
});

describe("password is never logged or persisted as plain JSON", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not put the password in console output or a persistable store snapshot", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    parseObsWebsocketConfig(
      JSON.stringify({
        server_enabled: true,
        server_port: 4455,
        auth_required: true,
        server_password: FAKE_PASSWORD,
      })
    );
    classifyObsConnectError(Object.assign(new Error("Authentication failed."), { code: 4009 }));
    await connectUsingObsConfig(new FakeObsClient(), enabledConfig);

    useAppStore.setState({
      showConfig: { ...DEFAULT_SHOW_CONFIG, obsPassword: FAKE_PASSWORD, obsPort: 4455 },
    });
    const persisted = persistableShowConfig(useAppStore.getState().showConfig);
    expect(persisted.obsPassword).toBe("");
    expect(JSON.stringify(persisted)).not.toContain(FAKE_PASSWORD);
    useAppStore.setState({ showConfig: { ...DEFAULT_SHOW_CONFIG } });

    const dumped = [...log.mock.calls, ...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(dumped).not.toContain(FAKE_PASSWORD);
  });
});

describe("Try again re-reads OBS's config", () => {
  beforeEach(() => {
    useAppStore.setState({ showConfig: { ...DEFAULT_SHOW_CONFIG } });
  });

  it("calls loadConfig again on retry instead of reusing a cached parse", async () => {
    let enabled = false;
    let reads = 0;
    const loadConfig = async (): Promise<ObsWebsocketConfig> => {
      reads += 1;
      return parseObsWebsocketConfig(
        JSON.stringify({
          server_enabled: enabled,
          server_port: 4455,
          auth_required: true,
          server_password: FAKE_PASSWORD,
        })
      );
    };

    const attempts: string[] = [];
    const client = new FakeObsClient();
    const session = startObsSetupSession({
      client,
      loadConfig,
      enumerate: async () => ({
        video: [{ deviceId: "cam", label: "Cam" }],
        audio: [],
      }),
      onAttempt: (attempt) => {
        attempts.push(attempt.ok ? "ok" : attempt.reason);
      },
    });

    await waitUntil(() => attempts.includes("server-disabled"));
    expect(reads).toBe(1);
    expect(client.connectCalls).toBe(0);

    enabled = true;
    session.retry();
    await waitUntil(() => attempts.includes("ok"));
    expect(reads).toBe(2);
    expect(client.connectCalls).toBe(1);
    session.stop();
  });
});

describe("setup screen copy does not cross the stream key with the OBS password", () => {
  it("gives each button its own job in seller language", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "SetupScreen.tsx"),
      "utf8"
    );
    expect(src).toContain("SETUP_SHOW_TOOLS_HINT");
    expect(src).toContain("SETUP_COPY_OBS_PASSWORD_HINT");
    expect(src).not.toContain("Paste it into Whatnot's Show Tools page.");
    expect(SETUP_SHOW_TOOLS_HINT.toLowerCase()).toMatch(/stream key/);
    expect(SETUP_COPY_OBS_PASSWORD_HINT.toLowerCase()).not.toMatch(/show tools/);
    expect(SETUP_COPY_OBS_PASSWORD_HINT.toLowerCase()).not.toMatch(/stream key/);
  });
});
