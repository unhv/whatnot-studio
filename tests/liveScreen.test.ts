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
});
