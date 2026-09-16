import { describe, it, expect, beforeEach } from "vitest";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import { startCameraPanelSocket } from "../src/renderer/CameraLayoutPanel.js";
import {
  CAMERA_LAYOUT_OBS_DEBOUNCE_MS,
  CameraLayoutObsSync,
  bothCameraTransforms,
  cameraLayoutReducer,
  cornerPosition,
  DEFAULT_CAMERA_LAYOUT,
  defaultCameraLayout,
  loadCameraLayout,
  persistCameraLayout,
  transformInsideCanvas,
  type CameraLayout,
  type CameraLayoutAction,
  type CameraLayoutClock,
  type Corner,
} from "../src/state/cameraLayout.js";
import {
  applyOpsToState,
  buildDesiredScenes,
  compileScenePlan,
  EMPTY_OBS_STATE,
  fullCanvasFillTransform,
} from "../src/obs/sceneCompiler.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, type ShowConfig } from "../src/shared/types.js";
import { useAppStore } from "../src/state/store.js";

const config: ShowConfig = {
  showName: "Test Show",
  camera: { deviceId: "cam-1", label: "Webcam" },
  mic: { deviceId: "mic-1", label: "Microphone" },
  captureCard: { deviceId: "cap-1", label: "Capture Card" },
  obsPassword: "pw",
  obsPort: 4455,
};

class ManualClock implements CameraLayoutClock {
  nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, fn });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  advance(ms: number): void {
    this.nowMs += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function makeClient(): FakeObsClient {
  return new FakeObsClient({
    GetSceneItemId: (data?: Record<string, unknown>) => ({
      sceneItemId: data?.sourceName === "Webcam" ? 2 : 1,
    }),
    SetSceneItemTransform: {},
    SetSceneItemIndex: {},
  });
}

function transformCalls(client: FakeObsClient) {
  return client.calls
    .filter((c) => c.requestType === "SetSceneItemTransform")
    .map((c) => ({
      source: c.requestData?.sceneItemId === 2 ? "Webcam" : "Capture Card",
      sceneName: c.requestData?.sceneName,
      transform: c.requestData?.sceneItemTransform,
    }));
}

function makeSync(client: FakeObsClient, clock?: ManualClock, storage?: MemoryStorage) {
  return new CameraLayoutObsSync({
    getClient: () => client,
    isConnected: () => true,
    getSourceNames: () => ({ webcam: "Webcam", table: "Capture Card" }),
    debounceMs: CAMERA_LAYOUT_OBS_DEBOUNCE_MS,
    clock,
    storage,
  });
}

const NAMED_LAYOUTS: { name: string; layout: CameraLayout }[] = [
  { name: "inset table-main small", layout: DEFAULT_CAMERA_LAYOUT },
  {
    name: "inset webcam-main small",
    layout: cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SWAP" }),
  },
  {
    name: "inset table-main large",
    layout: cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_SIZE", size: "large" }),
  },
  {
    name: "split",
    layout: cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_KIND", kind: "split" }),
  },
];

describe("named BOTH layouts → SetSceneItemTransform", () => {
  it("emits the exact transform payloads for both cameras, inside the canvas", async () => {
    for (const { layout } of NAMED_LAYOUTS) {
      const expected = bothCameraTransforms(layout);
      expect(transformInsideCanvas(expected.table)).toBe(true);
      expect(transformInsideCanvas(expected.webcam)).toBe(true);

      const client = makeClient();
      const sync = makeSync(client);
      sync.resync(layout);
      await sync.idle();

      expect(transformCalls(client)).toEqual([
        {
          source: "Capture Card",
          sceneName: "BOTH",
          transform: expected.table,
        },
        {
          source: "Webcam",
          sceneName: "BOTH",
          transform: expected.webcam,
        },
      ]);

      const desired = buildDesiredScenes(config, undefined, layout);
      const both = desired.find((s) => s.sceneName === "BOTH")!;
      const tableItem = both.items.find((i) => i.sourceName === "Capture Card")!;
      const camItem = both.items.find((i) => i.sourceName === "Webcam")!;
      expect(tableItem.transform).toEqual(expected.table);
      expect(camItem.transform).toEqual(expected.webcam);

      const displayed = (t: typeof expected.table) => ({
        right: t.positionX + (1920 - t.cropLeft - t.cropRight) * t.scaleX,
        bottom: t.positionY + (1080 - t.cropTop - t.cropBottom) * t.scaleY,
      });
      for (const t of [expected.table, expected.webcam]) {
        const box = displayed(t);
        expect(t.positionX).toBeGreaterThanOrEqual(0);
        expect(t.positionY).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(CANVAS_WIDTH + 0.5);
        expect(box.bottom).toBeLessThanOrEqual(CANVAS_HEIGHT + 0.5);
      }
    }
  });

  it("default inset is table filling the canvas and webcam in the small bottom-right tile", () => {
    const t = bothCameraTransforms(DEFAULT_CAMERA_LAYOUT);
    expect(t.table).toEqual(fullCanvasFillTransform());
    const br = cornerPosition("bottom-right", "small");
    expect(t.webcam.positionX).toBe(br.x);
    expect(t.webcam.positionY).toBe(br.y);
    expect(DEFAULT_CAMERA_LAYOUT.main).toBe("table");
    expect(DEFAULT_CAMERA_LAYOUT.kind).toBe("inset");
  });
});

describe("swap", () => {
  it("puts the other camera in the main slot and the first in the inset", async () => {
    const swapped = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SWAP" });
    expect(swapped.main).toBe("webcam");
    const t = bothCameraTransforms(swapped);
    expect(t.webcam).toEqual(fullCanvasFillTransform());
    expect(t.table.positionX).toBe(DEFAULT_CAMERA_LAYOUT.insetX);
    expect(t.table.positionY).toBe(DEFAULT_CAMERA_LAYOUT.insetY);
    expect(t.table).not.toEqual(fullCanvasFillTransform());

    const client = makeClient();
    const sync = makeSync(client);
    sync.notify({ type: "SWAP" }, swapped);
    await sync.idle();
    const calls = transformCalls(client);
    expect(calls.find((c) => c.source === "Webcam")?.transform).toEqual(t.webcam);
    expect(calls.find((c) => c.source === "Capture Card")?.transform).toEqual(t.table);
  });
});

describe("drag snap, debounced", () => {
  it("a drag to each snap point writes once per gesture, not per pixel", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = makeSync(client, clock);
    let state = defaultCameraLayout();

    function drive(action: CameraLayoutAction): void {
      const next = cameraLayoutReducer(state, action);
      sync.notify(action, next);
      state = next;
    }

    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"] as Corner[]) {
      const target = cornerPosition(corner, state.insetSize);
      const startX = state.insetX;
      const startY = state.insetY;
      const steps = 12;
      const before = transformCalls(client).length;

      for (let i = 1; i <= steps; i++) {
        drive({
          type: "MOVE_INSET",
          x: startX + ((target.x - startX) * i) / steps,
          y: startY + ((target.y - startY) * i) / steps,
        });
      }
      expect(transformCalls(client).length).toBe(before);

      drive({ type: "END_DRAG" });
      await sync.idle();

      expect(state.insetX).toBe(target.x);
      expect(state.insetY).toBe(target.y);
      expect(transformCalls(client).length).toBe(before + 2);

      const last = bothCameraTransforms(state);
      const calls = transformCalls(client).slice(-2);
      expect(calls).toEqual([
        { source: "Capture Card", sceneName: "BOTH", transform: last.table },
        { source: "Webcam", sceneName: "BOTH", transform: last.webcam },
      ]);
    }
  });

  it("a mid-drag pause still collapses to one write after the debounce", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = makeSync(client, clock);
    let state = defaultCameraLayout();
    for (const x of [700, 680, 640, 600, 560]) {
      const next = cameraLayoutReducer(state, { type: "MOVE_INSET", x, y: state.insetY });
      sync.notify({ type: "MOVE_INSET", x, y: state.insetY }, next);
      state = next;
    }
    expect(transformCalls(client)).toEqual([]);
    clock.advance(CAMERA_LAYOUT_OBS_DEBOUNCE_MS - 1);
    await sync.idle();
    expect(transformCalls(client)).toEqual([]);
    clock.advance(1);
    await sync.idle();
    expect(transformCalls(client)).toHaveLength(2);
  });
});

describe("persist across restart and reconnect", () => {
  it("survives a restart and is reapplied on reconnect", async () => {
    const storage = new MemoryStorage();
    let state = defaultCameraLayout();
    state = cameraLayoutReducer(state, { type: "SET_SIZE", size: "large" });
    state = cameraLayoutReducer(state, { type: "SWAP" });
    state = cameraLayoutReducer(state, { type: "SNAP", corner: "top-left" });
    persistCameraLayout(state, storage);

    const loaded = loadCameraLayout(storage);
    expect(loaded).toEqual(state);

    const client = makeClient();
    const sync = makeSync(client, undefined, storage);
    useAppStore.setState({ connectionStatus: "disconnected" });
    sync.resync(loaded);
    await sync.idle();
    const afterRestart = transformCalls(client);
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart[0].transform).toEqual(bothCameraTransforms(loaded).table);

    client.calls = [];
    useAppStore.setState({ connectionStatus: "connected" });
    sync.resync(loadCameraLayout(storage));
    await sync.idle();
    expect(transformCalls(client)).toEqual(afterRestart);
  });
});

describe("OBS disconnected", () => {
  beforeEach(() => {
    useAppStore.setState({ connectionStatus: "disconnected" });
  });

  it("survives OBS being disconnected while the controls are used", async () => {
    const throwing = new FakeObsClient();
    throwing.call = async () => {
      throw new Error("not connected");
    };
    const sync = new CameraLayoutObsSync({
      getClient: () => throwing,
      isConnected: () => false,
      getSourceNames: () => ({ webcam: "Webcam", table: "Capture Card" }),
    });

    let state = defaultCameraLayout();
    expect(() => {
      for (const action of [
        { type: "MOVE_INSET", x: 100, y: 200 },
        { type: "END_DRAG" },
        { type: "SET_SIZE", size: "large" },
        { type: "SWAP" },
        { type: "SET_KIND", kind: "split" },
      ] as CameraLayoutAction[]) {
        const next = cameraLayoutReducer(state, action);
        sync.notify(action, next);
        state = next;
      }
    }).not.toThrow();
    await expect(sync.idle()).resolves.toBeUndefined();
    expect(state.kind).toBe("split");
    expect(state.main).toBe("webcam");

    const connectedSync = new CameraLayoutObsSync({
      getClient: () => throwing,
      isConnected: () => true,
      getSourceNames: () => ({ webcam: "Webcam", table: "Capture Card" }),
    });
    expect(() => connectedSync.notify({ type: "SWAP" }, state)).not.toThrow();
    await expect(connectedSync.idle()).resolves.toBeUndefined();
  });
});

describe("BOTH z-order with a surround", () => {
  function indexCalls(client: FakeObsClient) {
    return client.calls
      .filter((c) => c.requestType === "SetSceneItemIndex")
      .map((c) => ({
        sceneItemId: c.requestData?.sceneItemId,
        sceneItemIndex: c.requestData?.sceneItemIndex,
      }));
  }

  it("pins cameras at 0 and 1 when there is no surround", async () => {
    const client = makeClient();
    const sync = makeSync(client);
    sync.resync(DEFAULT_CAMERA_LAYOUT);
    await sync.idle();
    expect(indexCalls(client)).toEqual([
      { sceneItemId: 1, sceneItemIndex: 0 },
      { sceneItemId: 2, sceneItemIndex: 1 },
    ]);
  });

  it("leaves index 0 for the surround and writes cameras at 1 and 2", async () => {
    const layout = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, {
      type: "SET_SURROUND",
      surroundId: "warm-glow",
    });
    const client = makeClient();
    const sync = makeSync(client);
    sync.resync(layout);
    await sync.idle();
    expect(indexCalls(client)).toEqual([
      { sceneItemId: 1, sceneItemIndex: 1 },
      { sceneItemId: 2, sceneItemIndex: 2 },
    ]);
  });

  it("does not race SET_SURROUND against the BOTH transform write", async () => {
    const layout = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, {
      type: "SET_SURROUND",
      surroundId: "cool-dusk",
    });
    const client = makeClient();
    const sync = makeSync(client);
    sync.notify({ type: "SET_SURROUND", surroundId: "cool-dusk" }, layout);
    await sync.idle();
    expect(transformCalls(client)).toEqual([]);
    expect(indexCalls(client)).toEqual([]);
    sync.resync(layout);
    await sync.idle();
    expect(transformCalls(client)).toHaveLength(2);
    expect(indexCalls(client)).toEqual([
      { sceneItemId: 1, sceneItemIndex: 1 },
      { sceneItemId: 2, sceneItemIndex: 2 },
    ]);
  });
});

describe("buildDesiredScenes BOTH layout", () => {
  it("only the BOTH camera transforms change with the named layout", () => {
    const inset = buildDesiredScenes(config, undefined, DEFAULT_CAMERA_LAYOUT);
    const split = buildDesiredScenes(
      config,
      undefined,
      cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_KIND", kind: "split" })
    );
    expect(inset.find((s) => s.sceneName === "ME")).toEqual(split.find((s) => s.sceneName === "ME"));
    expect(inset.find((s) => s.sceneName === "TABLE")).toEqual(
      split.find((s) => s.sceneName === "TABLE")
    );
    expect(inset.find((s) => s.sceneName === "BREAK")).toEqual(
      split.find((s) => s.sceneName === "BREAK")
    );
    const bothInset = inset.find((s) => s.sceneName === "BOTH")!;
    const bothSplit = split.find((s) => s.sceneName === "BOTH")!;
    expect(bothInset.items.map((i) => i.sourceName)).toEqual(bothSplit.items.map((i) => i.sourceName));
    expect(bothInset.items[0].transform).not.toEqual(bothSplit.items[0].transform);
  });

  it("compile of a swapped layout still converges", () => {
    const layout = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SWAP" });
    const desired = buildDesiredScenes(config, undefined, layout);
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);
    const after = applyOpsToState(EMPTY_OBS_STATE, ops);
    expect(compileScenePlan(desired, after)).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for camera panel socket");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("camera panel owned socket reconnect", () => {
  it("reconnects after a simulated close, and stops once unmounted", async () => {
    const client = new FakeObsClient();
    const statuses: boolean[] = [];
    const session = startCameraPanelSocket({
      client,
      url: "ws://127.0.0.1:4455",
      password: "pw",
      retryMs: 15,
      onStatus: (connected) => statuses.push(connected),
    });

    await waitUntil(() => client.connectCalls === 1 && statuses.includes(true));
    expect(statuses.at(-1)).toBe(true);

    client.emit("ConnectionClosed");
    expect(statuses.at(-1)).toBe(false);
    await waitUntil(() => client.connectCalls === 2);
    expect(statuses.at(-1)).toBe(true);

    session.stop();
    const callsAfterStop = client.connectCalls;
    client.emit("ConnectionClosed");
    client.emit("ConnectionError");
    await new Promise((r) => setTimeout(r, 50));
    expect(client.connectCalls).toBe(callsAfterStop);
  });

  it("retries a close that arrives while the successful connect is still in flight", async () => {
    const client = new FakeObsClient();
    const statuses: boolean[] = [];
    let droppedOnce = false;
    const session = startCameraPanelSocket({
      client,
      url: "ws://127.0.0.1:4455",
      retryMs: 15,
      onStatus: (connected) => {
        statuses.push(connected);
        if (connected && !droppedOnce) {
          droppedOnce = true;
          client.emit("ConnectionClosed");
        }
      },
    });

    await waitUntil(() => client.connectCalls === 1 && statuses.includes(true));
    await waitUntil(() => client.connectCalls === 2);
    expect(statuses.at(-1)).toBe(true);

    session.stop();
    const callsAfterStop = client.connectCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(client.connectCalls).toBe(callsAfterStop);
  });

  it("retries after a connect error with a delay, then stops on unmount", async () => {
    const client = new FakeObsClient();
    let attempts = 0;
    client.connect = async () => {
      attempts += 1;
      client.connectCalls += 1;
      if (attempts === 1) throw new Error("obs down");
      client.connected = true;
    };

    const session = startCameraPanelSocket({
      client,
      url: "ws://127.0.0.1:4455",
      retryMs: 15,
      onStatus: () => {},
    });

    await waitUntil(() => client.connectCalls === 1);
    expect(client.connectCalls).toBe(1);
    await waitUntil(() => client.connectCalls === 2);
    expect(attempts).toBe(2);

    session.stop();
    const callsAfterStop = client.connectCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(client.connectCalls).toBe(callsAfterStop);
  });
});
