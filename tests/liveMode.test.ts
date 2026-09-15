import { describe, it, expect, beforeEach } from "vitest";
import {
  asStreamStateChangedEvent,
  deriveLiveState,
  deriveSocketDisconnect,
  elapsedMs,
  initialLiveState,
  liveScreenCopy,
  subscribeObsLiveState,
  LIVE_PRIMARY,
  LIVE_SECONDARY,
  type LiveState,
  type StreamStateChangedEvent,
} from "../src/obs/liveMode.js";
import { useAppStore } from "../src/state/store.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";

function event(outputState: string, outputActive: boolean): StreamStateChangedEvent {
  return { outputActive, outputState };
}

/** The exact five-event sequence captured from a real Whatnot show on 2026-09-15. */
const MEASURED_SEQUENCE: Array<{ outputState: string; outputActive: boolean }> = [
  { outputState: "OBS_WEBSOCKET_OUTPUT_STARTING", outputActive: false },
  { outputState: "OBS_WEBSOCKET_OUTPUT_STARTED", outputActive: true },
  { outputState: "OBS_WEBSOCKET_OUTPUT_RECONNECTING", outputActive: false },
  { outputState: "OBS_WEBSOCKET_OUTPUT_STOPPING", outputActive: false },
  { outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputActive: false },
];

describe("deriveLiveState — measured five-event sequence", () => {
  it("derives connecting / live / still-live / still-live / not-live in order", () => {
    let state = initialLiveState(0);

    state = deriveLiveState(state, event(MEASURED_SEQUENCE[0].outputState, MEASURED_SEQUENCE[0].outputActive), 1000);
    expect(state.live).toBe(false);
    expect(state.connecting).toBe(true);
    expect(state.reconnecting).toBe(false);
    expect(state.stopping).toBe(false);
    expect(state.since).toBe(1000);
    expect(liveScreenCopy(state)).toEqual({
      primary: LIVE_PRIMARY.goingLive,
      secondary: LIVE_SECONDARY.starting,
      showElapsed: false,
    });

    state = deriveLiveState(state, event(MEASURED_SEQUENCE[1].outputState, MEASURED_SEQUENCE[1].outputActive), 2000);
    expect(state.live).toBe(true);
    expect(state.connecting).toBe(false);
    expect(state.reconnecting).toBe(false);
    expect(state.stopping).toBe(false);
    expect(state.since).toBe(2000);
    expect(liveScreenCopy(state)).toEqual({
      primary: LIVE_PRIMARY.live,
      secondary: null,
      showElapsed: true,
    });

    state = deriveLiveState(state, event(MEASURED_SEQUENCE[2].outputState, MEASURED_SEQUENCE[2].outputActive), 3000);
    expect(state.live).toBe(true);
    expect(state.reconnecting).toBe(true);
    expect(state.connecting).toBe(false);
    expect(state.stopping).toBe(false);
    expect(state.since).toBe(2000);
    expect(liveScreenCopy(state)).toEqual({
      primary: LIVE_PRIMARY.live,
      secondary: LIVE_SECONDARY.reconnecting,
      showElapsed: true,
    });
    expect(liveScreenCopy(state).primary).not.toBe(LIVE_PRIMARY.notLive);

    state = deriveLiveState(state, event(MEASURED_SEQUENCE[3].outputState, MEASURED_SEQUENCE[3].outputActive), 4000);
    expect(state.live).toBe(true);
    expect(state.stopping).toBe(true);
    expect(state.reconnecting).toBe(false);
    expect(state.since).toBe(2000);
    expect(liveScreenCopy(state)).toEqual({
      primary: LIVE_PRIMARY.live,
      secondary: LIVE_SECONDARY.stopping,
      showElapsed: true,
    });

    state = deriveLiveState(state, event(MEASURED_SEQUENCE[4].outputState, MEASURED_SEQUENCE[4].outputActive), 5000);
    expect(state.live).toBe(false);
    expect(state.connecting).toBe(false);
    expect(state.reconnecting).toBe(false);
    expect(state.stopping).toBe(false);
    expect(state.since).toBe(5000);
    expect(liveScreenCopy(state)).toEqual({
      primary: LIVE_PRIMARY.notLive,
      secondary: null,
      showElapsed: false,
    });
  });

  it("does not reset the live timer when STARTED follows RECONNECTING", () => {
    let state = initialLiveState(0);
    state = deriveLiveState(state, event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    state = deriveLiveState(state, event("OBS_WEBSOCKET_OUTPUT_RECONNECTING", false), 5000);
    state = deriveLiveState(state, event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 8000);
    expect(state.live).toBe(true);
    expect(state.reconnecting).toBe(false);
    expect(state.since).toBe(1000);
    expect(elapsedMs(state, 8000)).toBe(7000);
  });
});

describe("deriveLiveState — unknown outputState", () => {
  it("leaves live-state unchanged and records the unrecognised string", () => {
    let state = initialLiveState(0);
    state = deriveLiveState(state, event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    const before: LiveState = { ...state };
    const next = deriveLiveState(state, event("OBS_WEBSOCKET_OUTPUT_SOME_FUTURE_STATE", false), 9000);
    expect(next.live).toBe(before.live);
    expect(next.connecting).toBe(before.connecting);
    expect(next.reconnecting).toBe(before.reconnecting);
    expect(next.stopping).toBe(before.stopping);
    expect(next.socketDisconnected).toBe(before.socketDisconnected);
    expect(next.since).toBe(before.since);
    expect(next.unrecognizedOutputState).toBe("OBS_WEBSOCKET_OUTPUT_SOME_FUTURE_STATE");
    expect(liveScreenCopy(next).primary).toBe(LIVE_PRIMARY.live);
  });
});

describe("deriveLiveState — outputActive is ignored", () => {
  it("stays live on STARTED even when outputActive is false", () => {
    const state = deriveLiveState(
      initialLiveState(0),
      event("OBS_WEBSOCKET_OUTPUT_STARTED", false),
      1000
    );
    expect(state.live).toBe(true);
  });

  it("does not leave live on RECONNECTING just because outputActive is false", () => {
    let state = deriveLiveState(initialLiveState(0), event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    state = deriveLiveState(state, event("OBS_WEBSOCKET_OUTPUT_RECONNECTING", false), 2000);
    expect(state.live).toBe(true);
    expect(state.reconnecting).toBe(true);
  });
});

describe("deriveSocketDisconnect", () => {
  it("does not render as not live when the websocket drops mid-show", () => {
    let state = deriveLiveState(initialLiveState(0), event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    state = deriveSocketDisconnect(state, 2500);
    expect(state.live).toBe(true);
    expect(state.socketDisconnected).toBe(true);
    expect(state.since).toBe(1000);
    const copy = liveScreenCopy(state);
    expect(copy.primary).toBe(LIVE_PRIMARY.live);
    expect(copy.primary).not.toBe(LIVE_PRIMARY.notLive);
    expect(copy.secondary).toBe(LIVE_SECONDARY.socketLostLive);
  });

  it("does not drop a connecting start into not-live either", () => {
    let state = deriveLiveState(initialLiveState(0), event("OBS_WEBSOCKET_OUTPUT_STARTING", false), 1000);
    state = deriveSocketDisconnect(state, 1500);
    expect(state.live).toBe(false);
    expect(state.connecting).toBe(true);
    const copy = liveScreenCopy(state);
    expect(copy.primary).toBe(LIVE_PRIMARY.goingLive);
    expect(copy.primary).not.toBe(LIVE_PRIMARY.notLive);
  });
});

describe("initialLiveState", () => {
  it("starts not-live", () => {
    expect(initialLiveState(0).live).toBe(false);
    expect(liveScreenCopy(initialLiveState(0)).primary).toBe(LIVE_PRIMARY.notLive);
  });
});

describe("subscribeObsLiveState", () => {
  it("folds StreamStateChanged through the handler, including RECONNECTING still live", () => {
    const client = new FakeObsClient();
    let state = initialLiveState(0);
    const unsub = subscribeObsLiveState(client, {
      onStreamStateChanged: (event, now) => {
        state = deriveLiveState(state, event, now);
      },
      onSocketDisconnect: (now) => {
        state = deriveSocketDisconnect(state, now);
      },
      now: () => 2000,
    });

    client.emit("StreamStateChanged", event("OBS_WEBSOCKET_OUTPUT_STARTED", true));
    client.emit("StreamStateChanged", event("OBS_WEBSOCKET_OUTPUT_RECONNECTING", false));
    expect(state.live).toBe(true);
    expect(state.reconnecting).toBe(true);
    expect(liveScreenCopy(state).primary).toBe(LIVE_PRIMARY.live);

    unsub();
    client.emit("StreamStateChanged", event("OBS_WEBSOCKET_OUTPUT_STOPPED", false));
    expect(state.live).toBe(true);
  });

  it("does not render a socket drop as not live", () => {
    const client = new FakeObsClient();
    let state = deriveLiveState(initialLiveState(0), event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    subscribeObsLiveState(client, {
      onStreamStateChanged: (event, now) => {
        state = deriveLiveState(state, event, now);
      },
      onSocketDisconnect: (now) => {
        state = deriveSocketDisconnect(state, now);
      },
      now: () => 2500,
    });

    client.emit("ConnectionClosed");
    expect(state.live).toBe(true);
    expect(state.socketDisconnected).toBe(true);
    expect(liveScreenCopy(state).primary).toBe(LIVE_PRIMARY.live);
    expect(liveScreenCopy(state).primary).not.toBe(LIVE_PRIMARY.notLive);
  });

  it("ignores a malformed StreamStateChanged payload", () => {
    const client = new FakeObsClient();
    let calls = 0;
    subscribeObsLiveState(client, {
      onStreamStateChanged: () => {
        calls += 1;
      },
      onSocketDisconnect: () => {},
    });
    client.emit("StreamStateChanged", { outputActive: false });
    expect(calls).toBe(0);
    expect(asStreamStateChangedEvent({ outputActive: false })).toBeNull();
  });
});

describe("store folds live-state (the path LiveScreen reads)", () => {
  beforeEach(() => {
    useAppStore.setState({ live: initialLiveState(0), connectionStatus: "disconnected" });
  });

  it("drives the measured five-event sequence into the store LiveScreen reads", () => {
    const { applyStreamStateChanged } = useAppStore.getState();
    applyStreamStateChanged(event(MEASURED_SEQUENCE[0].outputState, MEASURED_SEQUENCE[0].outputActive), 1000);
    expect(useAppStore.getState().live.connecting).toBe(true);
    expect(useAppStore.getState().live.live).toBe(false);

    applyStreamStateChanged(event(MEASURED_SEQUENCE[1].outputState, MEASURED_SEQUENCE[1].outputActive), 2000);
    expect(useAppStore.getState().live.live).toBe(true);

    applyStreamStateChanged(event(MEASURED_SEQUENCE[2].outputState, MEASURED_SEQUENCE[2].outputActive), 3000);
    const reconnecting = useAppStore.getState().live;
    expect(reconnecting.live).toBe(true);
    expect(reconnecting.reconnecting).toBe(true);
    expect(liveScreenCopy(reconnecting).primary).toBe(LIVE_PRIMARY.live);
    expect(liveScreenCopy(reconnecting).primary).not.toBe(LIVE_PRIMARY.notLive);

    applyStreamStateChanged(event(MEASURED_SEQUENCE[3].outputState, MEASURED_SEQUENCE[3].outputActive), 4000);
    expect(useAppStore.getState().live.live).toBe(true);
    expect(useAppStore.getState().live.stopping).toBe(true);

    applyStreamStateChanged(event(MEASURED_SEQUENCE[4].outputState, MEASURED_SEQUENCE[4].outputActive), 5000);
    expect(useAppStore.getState().live.live).toBe(false);
  });

  it("keeps the seller live when the websocket drops mid-show", () => {
    useAppStore.getState().applyStreamStateChanged(event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    useAppStore.getState().applySocketDisconnect(2500);
    const live = useAppStore.getState().live;
    expect(live.live).toBe(true);
    expect(live.socketDisconnected).toBe(true);
    expect(liveScreenCopy(live).primary).not.toBe(LIVE_PRIMARY.notLive);
  });
});

describe("elapsedMs", () => {
  it("counts up from `since`", () => {
    const state = deriveLiveState(initialLiveState(0), event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    expect(elapsedMs(state, 4500)).toBe(3500);
  });

  it("never goes negative", () => {
    const state = deriveLiveState(initialLiveState(0), event("OBS_WEBSOCKET_OUTPUT_STARTED", true), 1000);
    expect(elapsedMs(state, 500)).toBe(0);
  });
});
