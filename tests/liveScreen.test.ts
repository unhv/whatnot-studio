import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialLiveState,
  liveScreenCopy,
  LIVE_PRIMARY,
  LIVE_SECONDARY,
  type StreamStateChangedEvent,
} from "../src/obs/liveMode.js";
import { useAppStore } from "../src/state/store.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import {
  canReturnToSetup,
  returnToSetup,
  startLiveScreenSession,
} from "../src/renderer/liveScreenSession.js";
import { ITEM_BAR_SOURCE, SOLD_BANNER_SOURCE } from "../src/obs/sceneCompiler.js";
import {
  bothCameraTransforms,
  cameraLayoutReducer,
  DEFAULT_CAMERA_LAYOUT,
  persistCameraLayout,
  type StorageLike,
} from "../src/state/cameraLayout.js";
import { DEFAULT_SHOW_CONFIG } from "../src/state/store.js";
import { ENCODER_REVERT_MESSAGE, QUALITY_WHILE_LIVE } from "../src/obs/quality.js";
import { HEALTH_MACHINE, HEALTH_NETWORK } from "../src/obs/health.js";

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function event(outputState: string, outputActive: boolean): StreamStateChangedEvent {
  return { outputActive, outputState };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for live-screen session");
    }
    await Promise.resolve();
  }
}

describe("LiveScreen session — studio socket drop", () => {
  beforeEach(() => {
    useAppStore.setState({
      live: initialLiveState(0),
      connectionStatus: "disconnected",
      screen: "live",
    });
  });

  it("clears the drop flag on a successful connect, with no StreamStateChanged", async () => {
    useAppStore.getState().applySocketDisconnect(1000);
    expect(useAppStore.getState().live.socketDisconnected).toBe(true);
    expect(liveScreenCopy(useAppStore.getState().live).secondary).toBe(
      LIVE_SECONDARY.socketLostIdle
    );

    const client = new FakeObsClient();
    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");

    const live = useAppStore.getState().live;
    expect(live.socketDisconnected).toBe(false);
    expect(live.live).toBe(false);
    expect(liveScreenCopy(live)).toEqual({
      primary: LIVE_PRIMARY.notLive,
      secondary: null,
      showElapsed: false,
    });
    expect(client.connectCalls).toBe(1);
    session.stop();
  });

  it("clears a mid-show drop on reconnect and keeps the seller live", async () => {
    useAppStore
      .getState()
      .applyStreamStateChanged(event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    useAppStore.getState().applySocketDisconnect(2500);
    const dropped = useAppStore.getState().live;
    expect(dropped.live).toBe(true);
    expect(dropped.socketDisconnected).toBe(true);
    expect(liveScreenCopy(dropped).primary).toBe(LIVE_PRIMARY.live);
    expect(liveScreenCopy(dropped).secondary).toBe(LIVE_SECONDARY.socketLostLive);

    const client = new FakeObsClient();
    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");

    const live = useAppStore.getState().live;
    expect(live.live).toBe(true);
    expect(live.socketDisconnected).toBe(false);
    expect(live.since).toBe(1000);
    expect(liveScreenCopy(live)).toEqual({
      primary: LIVE_PRIMARY.live,
      secondary: null,
      showElapsed: true,
    });
    session.stop();
  });

  it("re-attaches the session listener after ConnectionClosed so STOPPED can arrive", async () => {
    useAppStore
      .getState()
      .applyStreamStateChanged(event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);

    const client = new FakeObsClient();
    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");

    client.emit("ConnectionClosed");
    expect(useAppStore.getState().live.live).toBe(true);
    expect(useAppStore.getState().live.socketDisconnected).toBe(true);
    expect(canReturnToSetup(useAppStore.getState().live)).toBe(true);

    session.retryNow();
    await waitUntil(
      () =>
        useAppStore.getState().connectionStatus === "connected" &&
        useAppStore.getState().live.socketDisconnected === false
    );

    client.emit("StreamStateChanged", event("OBS_WEBSOCKET_OUTPUT_STOPPED", false));
    const afterStop = useAppStore.getState().live;
    expect(afterStop.live).toBe(false);
    expect(afterStop.socketDisconnected).toBe(false);
    expect(liveScreenCopy(afterStop).primary).toBe(LIVE_PRIMARY.notLive);

    returnToSetup();
    expect(useAppStore.getState().screen).toBe("setup");
    session.stop();
  });

  it("lets the seller return to Setup while still marked live if the studio socket is down", () => {
    useAppStore
      .getState()
      .applyStreamStateChanged(event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    useAppStore.getState().applySocketDisconnect(2500);
    const live = useAppStore.getState().live;
    expect(live.live).toBe(true);
    expect(canReturnToSetup(live)).toBe(true);

    useAppStore.getState().goToSetup();
    expect(useAppStore.getState().screen).toBe("live");

    returnToSetup();
    expect(useAppStore.getState().screen).toBe("setup");
  });

  it("does not offer Setup while live and the studio socket is up", () => {
    useAppStore
      .getState()
      .applyStreamStateChanged(event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    expect(canReturnToSetup(useAppStore.getState().live)).toBe(false);
    returnToSetup();
    expect(useAppStore.getState().screen).toBe("live");
  });

  it("applies the scene plan once on first connect, not again on reconnect", async () => {
    const applied: number[] = [];
    const client = new FakeObsClient();
    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
      applyScenes: async () => {
        applied.push(Date.now());
      },
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");
    expect(applied).toHaveLength(1);

    client.emit("ConnectionClosed");
    session.retryNow();
    await waitUntil(
      () =>
        useAppStore.getState().connectionStatus === "connected" &&
        useAppStore.getState().live.socketDisconnected === false
    );
    expect(applied).toHaveLength(1);
    session.stop();
  });

  it("creates the Item Bar and SOLD Banner inputs on first connect against a skeleton collection", async () => {
    const scenes = new Map<string, { sourceName: string; sceneItemId: number }[]>();
    scenes.set("Scene", []);
    const inputs: { inputName: string; inputKind: string }[] = [];
    let nextId = 1;

    const client = new FakeObsClient({
      GetSceneList: () => ({ scenes: [...scenes.keys()].map((sceneName) => ({ sceneName })) }),
      GetInputList: () => ({ inputs: [...inputs] }),
      GetSceneItemList: (data?: Record<string, unknown>) => ({
        sceneItems: (scenes.get(String(data?.sceneName)) ?? []).map((i) => ({
          sourceName: i.sourceName,
          sceneItemId: i.sceneItemId,
          sceneItemEnabled: false,
        })),
      }),
      CreateScene: (data?: Record<string, unknown>) => {
        const name = String(data?.sceneName);
        if (!scenes.has(name)) scenes.set(name, []);
        return {};
      },
      CreateInput: (data?: Record<string, unknown>) => {
        const inputName = String(data?.inputName);
        const sceneName = String(data?.sceneName);
        inputs.push({ inputName, inputKind: String(data?.inputKind) });
        const list = scenes.get(sceneName) ?? [];
        list.push({ sourceName: inputName, sceneItemId: nextId++ });
        scenes.set(sceneName, list);
        return {};
      },
      CreateSceneItem: (data?: Record<string, unknown>) => {
        const sceneName = String(data?.sceneName);
        const sourceName = String(data?.sourceName);
        const list = scenes.get(sceneName) ?? [];
        list.push({ sourceName, sceneItemId: nextId++ });
        scenes.set(sceneName, list);
        return {};
      },
      SetSceneItemTransform: {},
      SetSceneItemEnabled: {},
    });

    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");

    const created = client.calls
      .filter((c) => c.requestType === "CreateInput")
      .map((c) => c.requestData?.inputName);
    expect(created).toContain(ITEM_BAR_SOURCE);
    expect(created).toContain(SOLD_BANNER_SOURCE);
    expect(created.filter((n) => n === ITEM_BAR_SOURCE)).toHaveLength(1);
    expect(created.filter((n) => n === SOLD_BANNER_SOURCE)).toHaveLength(1);

    const overlayEnables = client.calls.filter(
      (c) =>
        c.requestType === "SetSceneItemEnabled" &&
        (c.requestData?.sceneItemEnabled === false || c.requestData?.sceneItemEnabled === true)
    );
    expect(overlayEnables.length).toBeGreaterThan(0);
    session.stop();
  });

  it("applies the persisted BOTH layout on first connect, not the stock inset", async () => {
    const twoCameras = {
      ...DEFAULT_SHOW_CONFIG,
      camera: { deviceId: "cam-1", label: "Webcam" },
      captureCard: { deviceId: "cap-1", label: "Capture Card" },
      mic: { deviceId: "mic-1", label: "Microphone" },
    };
    useAppStore.setState({ showConfig: twoCameras });

    const storage = new MemoryStorage();
    const layout = cameraLayoutReducer(
      cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_KIND", kind: "split" }),
      { type: "SWAP" }
    );
    persistCameraLayout(layout, storage);
    const expected = bothCameraTransforms(layout);
    const stock = bothCameraTransforms(DEFAULT_CAMERA_LAYOUT);

    const scenes = new Map<string, { sourceName: string; sceneItemId: number }[]>();
    scenes.set("Scene", []);
    const inputs: { inputName: string; inputKind: string }[] = [];
    let nextId = 1;

    const client = new FakeObsClient({
      GetSceneList: () => ({ scenes: [...scenes.keys()].map((sceneName) => ({ sceneName })) }),
      GetInputList: () => ({ inputs: [...inputs] }),
      GetSceneItemList: (data?: Record<string, unknown>) => ({
        sceneItems: (scenes.get(String(data?.sceneName)) ?? []).map((i) => ({
          sourceName: i.sourceName,
          sceneItemId: i.sceneItemId,
          sceneItemEnabled: false,
        })),
      }),
      GetSceneItemId: (data?: Record<string, unknown>) => {
        const list = scenes.get(String(data?.sceneName)) ?? [];
        const item = list.find((i) => i.sourceName === String(data?.sourceName));
        if (!item) throw new Error("missing scene item");
        return { sceneItemId: item.sceneItemId };
      },
      CreateScene: (data?: Record<string, unknown>) => {
        const name = String(data?.sceneName);
        if (!scenes.has(name)) scenes.set(name, []);
        return {};
      },
      CreateInput: (data?: Record<string, unknown>) => {
        const inputName = String(data?.inputName);
        const sceneName = String(data?.sceneName);
        inputs.push({ inputName, inputKind: String(data?.inputKind) });
        const list = scenes.get(sceneName) ?? [];
        list.push({ sourceName: inputName, sceneItemId: nextId++ });
        scenes.set(sceneName, list);
        return {};
      },
      CreateSceneItem: (data?: Record<string, unknown>) => {
        const sceneName = String(data?.sceneName);
        const sourceName = String(data?.sourceName);
        const list = scenes.get(sceneName) ?? [];
        list.push({ sourceName, sceneItemId: nextId++ });
        scenes.set(sceneName, list);
        return {};
      },
      SetSceneItemTransform: {},
      SetSceneItemEnabled: {},
    });

    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
      layoutStorage: storage,
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");

    const bothTransforms = client.calls.filter(
      (c) => c.requestType === "SetSceneItemTransform" && c.requestData?.sceneName === "BOTH"
    );
    const bySource = (name: string) => {
      const list = scenes.get("BOTH") ?? [];
      const id = list.find((i) => i.sourceName === name)?.sceneItemId;
      return bothTransforms.find((c) => c.requestData?.sceneItemId === id)?.requestData
        ?.sceneItemTransform;
    };
    expect(bySource("Capture Card")).toEqual(expected.table);
    expect(bySource("Webcam")).toEqual(expected.webcam);
    expect(bySource("Capture Card")).not.toEqual(stock.table);
    expect(bySource("Webcam")).not.toEqual(stock.webcam);

    session.stop();
    useAppStore.setState({ showConfig: DEFAULT_SHOW_CONFIG });
  });

  it("retries the scene plan on the next connect if the first apply throws", async () => {
    let attempts = 0;
    const client = new FakeObsClient();
    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
      applyScenes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("obs not ready");
      },
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");
    expect(attempts).toBe(1);

    client.emit("ConnectionClosed");
    session.retryNow();
    await waitUntil(
      () =>
        useAppStore.getState().connectionStatus === "connected" &&
        useAppStore.getState().live.socketDisconnected === false
    );
    expect(attempts).toBe(2);
    session.stop();
  });
});

describe("LIVE screen — quality health and encoder revert", () => {
  const liveSrc = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "LiveScreen.tsx"),
    "utf8"
  );

  beforeEach(() => {
    useAppStore.setState({
      live: initialLiveState(0),
      connectionStatus: "disconnected",
      screen: "live",
      healthWarning: null,
      encoderRevertMessage: null,
      showConfig: { ...DEFAULT_SHOW_CONFIG },
    });
  });

  it("shows distinct network and machine copy, no mid-show quality control, and never StartStream", () => {
    expect(liveSrc).toContain("healthWarning");
    expect(liveSrc).toContain("QUALITY_WHILE_LIVE");
    expect(liveSrc).toContain("encoderRevertMessage");
    expect(liveSrc).not.toMatch(/lower the quality/i);
    expect(liveSrc).not.toMatch(/StartStream/);
    expect(liveSrc).not.toMatch(/StopStream/);
    expect(QUALITY_WHILE_LIVE).toMatch(/before the next show/);
    expect(HEALTH_NETWORK).toMatch(/internet/);
    expect(HEALTH_MACHINE).toMatch(/computer/);
  });

  it("reverts the graphics-card encoder when Go Live never becomes live", async () => {
    useAppStore.setState({
      showConfig: {
        ...DEFAULT_SHOW_CONFIG,
        hardwareEncoder: true,
        hardwareEncoderPending: true,
        previousSimpleEncoder: "x264",
        previousAdvEncoder: "obs_x264",
      },
    });
    const client = new FakeObsClient({
      SetProfileParameter: {},
    });
    const session = startLiveScreenSession({
      client,
      url: "ws://127.0.0.1:4455",
      password: "",
      applyScenes: async () => {},
    });
    await waitUntil(() => useAppStore.getState().connectionStatus === "connected");
    client.emit("StreamStateChanged", event("OBS_WEBSOCKET_OUTPUT_STARTING", false));
    client.emit("StreamStateChanged", event("OBS_WEBSOCKET_OUTPUT_STOPPED", false));
    await waitUntil(() => useAppStore.getState().encoderRevertMessage === ENCODER_REVERT_MESSAGE);
    expect(useAppStore.getState().showConfig.hardwareEncoder).toBe(false);
    expect(useAppStore.getState().showConfig.hardwareEncoderPending).toBe(false);
    const encoderWrites = client.calls.filter(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === "StreamEncoder"
    );
    expect(encoderWrites[encoderWrites.length - 1]?.requestData?.parameterValue).toBe("x264");
    expect(client.calls.some((c) => c.requestType === "StartStream" || c.requestType === "StopStream")).toBe(false);
    session.stop();
  });
});
