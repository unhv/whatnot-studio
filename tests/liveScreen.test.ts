import { describe, it, expect, beforeEach } from "vitest";
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
