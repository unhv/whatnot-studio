import { describe, it, expect, beforeEach } from "vitest";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import {
  CAMERA_FACING_SCENES,
  ITEM_BAR_SOURCE,
  overlaySnapTransform,
  overlayStyleSettings,
  overlayTransformAt,
  SOLD_BANNER_SOURCE,
  TEXT_SNAP_NAMES,
  type TextOverlayId,
  type TextSnapName,
} from "../src/obs/sceneCompiler.js";
import {
  initialTextStyleState,
  loadTextStyle,
  persistTextStyle,
  TEXT_STYLE_OBS_DEBOUNCE_MS,
  textStyleReducer,
  TextStyleObsSync,
  type StorageLike,
  type TextStyleAction,
  type TextStyleClock,
  type TextStyleState,
} from "../src/state/textStyle.js";
import {
  initialItemBarState,
  itemBarReducer,
} from "../src/state/itemBar.js";
import {
  ItemBarObsSync,
  resetItemBarOverlayFlags,
  setItemBarObsSync,
  useAppStore,
} from "../src/state/store.js";
import type { ShowConfig } from "../src/shared/types.js";

class ManualClock implements TextStyleClock {
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

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function makeClient(overrides: ConstructorParameters<typeof FakeObsClient>[0] = {}): FakeObsClient {
  return new FakeObsClient({
    GetSceneItemId: () => ({ sceneItemId: 7 }),
    SetInputSettings: {},
    SetSceneItemTransform: {},
    SetSceneItemEnabled: {},
    GetSceneList: { scenes: [] },
    GetInputList: { inputs: [] },
    ...overrides,
  });
}

function drive(
  sync: TextStyleObsSync,
  actions: TextStyleAction[],
  reason: "drag" | "commit" = "commit"
): TextStyleState {
  let state = initialTextStyleState();
  for (const action of actions) {
    const next = textStyleReducer(state, action);
    sync.notify(state, next, action.type === "DRAG" ? "drag" : reason);
    state = next;
  }
  return state;
}

const restoreConfig: ShowConfig = {
  showName: "Friday Night",
  camera: { deviceId: "cam-1", label: "Webcam" },
  mic: { deviceId: "mic-1", label: "Microphone" },
  captureCard: { deviceId: "cap-1", label: "Capture Card" },
  obsPassword: "pw",
  obsPort: 4455,
};

function makeRestoreClient(): { client: FakeObsClient; lastEnabled: Map<string, boolean> } {
  type SceneItem = { sourceName: string; sceneItemId: number; sceneItemEnabled: boolean };
  const scenes: Record<string, SceneItem[]> = {
    ME: [{ sourceName: "Webcam", sceneItemId: 1, sceneItemEnabled: true }],
    TABLE: [{ sourceName: "Capture Card", sceneItemId: 1, sceneItemEnabled: true }],
    BOTH: [
      { sourceName: "Capture Card", sceneItemId: 1, sceneItemEnabled: true },
      { sourceName: "Webcam", sceneItemId: 2, sceneItemEnabled: true },
    ],
    BREAK: [],
  };
  const inputs = [
    { inputName: "Webcam", inputKind: "dshow_input" },
    { inputName: "Capture Card", inputKind: "dshow_input" },
  ];
  const lastEnabled = new Map<string, boolean>();
  let nextId = 10;
  const client = new FakeObsClient({
    GetSceneList: () => ({
      scenes: Object.keys(scenes).map((sceneName) => ({ sceneName })),
    }),
    GetInputList: () => ({ inputs: inputs.map((i) => ({ ...i })) }),
    GetSceneItemList: (data?: Record<string, unknown>) => ({
      sceneItems: (scenes[data?.sceneName as string] ?? []).map((it) => ({ ...it })),
    }),
    GetSceneItemId: (data?: Record<string, unknown>) => {
      const item = (scenes[data?.sceneName as string] ?? []).find((i) => i.sourceName === data?.sourceName);
      if (!item) throw new Error("No scene item");
      return { sceneItemId: item.sceneItemId };
    },
    CreateInput: (data?: Record<string, unknown>) => {
      const inputName = String(data?.inputName ?? "");
      inputs.push({ inputName, inputKind: String(data?.inputKind ?? "") });
      const sceneName = String(data?.sceneName ?? "");
      const sceneItemId = nextId++;
      scenes[sceneName] = scenes[sceneName] ?? [];
      scenes[sceneName].push({ sourceName: inputName, sceneItemId, sceneItemEnabled: true });
      return { sceneItemId };
    },
    CreateSceneItem: (data?: Record<string, unknown>) => {
      const sceneName = String(data?.sceneName ?? "");
      const sourceName = String(data?.sourceName ?? "");
      const sceneItemId = nextId++;
      scenes[sceneName] = scenes[sceneName] ?? [];
      scenes[sceneName].push({ sourceName, sceneItemId, sceneItemEnabled: true });
      return { sceneItemId };
    },
    CreateScene: {},
    SetSceneItemTransform: {},
    SetSceneItemEnabled: (data?: Record<string, unknown>) => {
      const sceneName = String(data?.sceneName ?? "");
      const sceneItemId = data?.sceneItemId as number;
      const item = (scenes[sceneName] ?? []).find((i) => i.sceneItemId === sceneItemId);
      if (item) {
        item.sceneItemEnabled = Boolean(data?.sceneItemEnabled);
        lastEnabled.set(`${sceneName}\0${item.sourceName}`, item.sceneItemEnabled);
      }
      return {};
    },
    SetInputSettings: {},
  });
  return { client, lastEnabled };
}

describe("TextStyleObsSync", () => {
  beforeEach(() => {
    resetItemBarOverlayFlags();
    setItemBarObsSync(null);
    useAppStore.setState({ itemBar: initialItemBarState(), connectionStatus: "connected" });
  });

  it("drags to each snap point and writes the exact SetSceneItemTransform payload", async () => {
    const client = makeClient();
    const sync = new TextStyleObsSync({ getClient: () => client });
    const id: TextOverlayId = "itemBar";

    let state = initialTextStyleState();
    for (const snap of TEXT_SNAP_NAMES) {
      client.calls = [];
      const t = overlaySnapTransform(id, snap, "normal");
      const next = textStyleReducer(state, { type: "DROP", id, x: t.positionX, y: t.positionY });
      sync.notify(state, next, "commit");
      state = next;
      await sync.idle();

      const expected = overlayTransformAt(t.positionX, t.positionY);
      const writes = client.calls.filter((c) => c.requestType === "SetSceneItemTransform");
      expect(writes).toHaveLength(CAMERA_FACING_SCENES.length);
      for (const sceneName of CAMERA_FACING_SCENES) {
        expect(writes).toContainEqual({
          requestType: "SetSceneItemTransform",
          requestData: {
            sceneName,
            sceneItemId: 7,
            sceneItemTransform: expected,
          },
        });
      }
      expect(state.overlays.itemBar.snap).toBe(snap);
    }
  });

  it("a drag does not emit a write per pixel — one SetSceneItemTransform after debounce", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = new TextStyleObsSync({ getClient: () => client, clock });

    let state = initialTextStyleState();
    const start = state.overlays.itemBar;
    for (let i = 1; i <= 40; i++) {
      const next = textStyleReducer(state, {
        type: "DRAG",
        id: "itemBar",
        x: start.positionX,
        y: start.positionY - i * 4,
      });
      sync.notify(state, next, "drag");
      state = next;
    }

    expect(client.calls.filter((c) => c.requestType === "SetSceneItemTransform")).toEqual([]);
    clock.advance(TEXT_STYLE_OBS_DEBOUNCE_MS - 1);
    await sync.idle();
    expect(client.calls.filter((c) => c.requestType === "SetSceneItemTransform")).toEqual([]);

    clock.advance(1);
    await sync.idle();
    const writes = client.calls.filter((c) => c.requestType === "SetSceneItemTransform");
    expect(writes).toHaveLength(CAMERA_FACING_SCENES.length);
    expect(writes[0].requestData?.sceneItemTransform).toEqual(
      overlayTransformAt(state.overlays.itemBar.positionX, state.overlays.itemBar.positionY)
    );
  });

  it("colour and size reach OBS as SetInputSettings, debounced", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = new TextStyleObsSync({ getClient: () => client, clock });

    drive(sync, [
      { type: "COLOR", id: "itemBar", colorref: 0x000000ff },
      { type: "COLOR", id: "itemBar", colorref: 0x0028c8ff },
      { type: "SIZE", id: "itemBar", size: "small" },
      { type: "SIZE", id: "itemBar", size: "huge" },
    ]);

    expect(client.calls.filter((c) => c.requestType === "SetInputSettings")).toEqual([]);
    clock.advance(TEXT_STYLE_OBS_DEBOUNCE_MS);
    await sync.idle();

    const settings = client.calls.filter(
      (c) => c.requestType === "SetInputSettings" && c.requestData?.inputName === ITEM_BAR_SOURCE
    );
    expect(settings).toHaveLength(1);
    expect(settings[0].requestData).toEqual({
      inputName: ITEM_BAR_SOURCE,
      inputSettings: overlayStyleSettings("itemBar", { colorref: 0x0028c8ff, size: "huge" }),
      overlay: true,
    });
    expect(settings[0].requestData?.inputSettings).not.toHaveProperty("text");
  });

  it("settings survive a restart and are reapplied on reconnect", async () => {
    const storage = new MemoryStorage();
    let state = initialTextStyleState();
    state = textStyleReducer(state, { type: "SNAP", id: "itemBar", snap: "top" as TextSnapName });
    state = textStyleReducer(state, { type: "COLOR", id: "itemBar", colorref: 0x000000ff });
    persistTextStyle("Saturday", state, storage);

    const rehydrated = loadTextStyle("Saturday", storage);
    expect(rehydrated.overlays.itemBar.snap).toBe("top");
    expect(rehydrated.overlays.itemBar.colorref).toBe(0x000000ff);

    const client = makeClient();
    const sync = new TextStyleObsSync({ getClient: () => client });
    sync.resync(rehydrated);
    await sync.idle();

    const top = overlaySnapTransform("itemBar", "top", "normal");
    const transforms = client.calls.filter((c) => c.requestType === "SetSceneItemTransform");
    expect(transforms).toContainEqual({
      requestType: "SetSceneItemTransform",
      requestData: {
        sceneName: "ME",
        sceneItemId: 7,
        sceneItemTransform: overlayTransformAt(top.positionX, top.positionY),
      },
    });
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetInputSettings" &&
          c.requestData?.inputName === ITEM_BAR_SOURCE &&
          (c.requestData.inputSettings as { color: number }).color === 0x000000ff
      )
    ).toBe(true);
  });

  it("survives OBS being disconnected while the controls are used", async () => {
    const throwing = new FakeObsClient();
    throwing.call = async () => {
      throw new Error("not connected");
    };
    const sync = new TextStyleObsSync({ getClient: () => throwing });

    expect(() => {
      drive(sync, [
        { type: "DRAG", id: "itemBar", x: 40, y: 800 },
        { type: "DROP", id: "itemBar", x: overlaySnapTransform("itemBar", "middle", "normal").positionX, y: overlaySnapTransform("itemBar", "middle", "normal").positionY },
        { type: "COLOR", id: "soldBanner", colorref: 0xffffff },
        { type: "SIZE", id: "breakCard", size: "huge" },
        { type: "TOGGLE", id: "breakCard" },
      ]);
    }).not.toThrow();
    await expect(sync.idle()).resolves.toBeUndefined();

    const disconnected = new TextStyleObsSync({ getClient: () => null, isConnected: () => false });
    expect(() => {
      drive(disconnected, [
        { type: "SNAP", id: "itemBar", snap: "safe" },
        { type: "COLOR", id: "itemBar", colorref: 0x000000 },
      ]);
    }).not.toThrow();
    await expect(disconnected.idle()).resolves.toBeUndefined();
  });

  it("reports a missing text source in seller language instead of failing silent", async () => {
    const missing: TextOverlayId[] = [];
    const client = new FakeObsClient({
      GetSceneItemId: () => {
        throw new Error("No scene item");
      },
      SetInputSettings: () => {
        throw new Error("No input");
      },
    });
    const sync = new TextStyleObsSync({
      getClient: () => client,
      reportMissing: (ids) => {
        missing.splice(0, missing.length, ...ids);
      },
    });
    const t = overlaySnapTransform("itemBar", "top", "normal");
    drive(sync, [{ type: "DROP", id: "itemBar", x: t.positionX, y: t.positionY }]);
    await sync.idle();
    expect(missing).toContain("itemBar");
  });

  it("break-card hide writes SetSceneItemEnabled on BREAK only", async () => {
    const client = makeClient();
    const sync = new TextStyleObsSync({ getClient: () => client });
    drive(sync, [{ type: "TOGGLE", id: "breakCard" }]);
    await sync.idle();
    const enables = client.calls.filter((c) => c.requestType === "SetSceneItemEnabled");
    expect(enables).toEqual([
      {
        requestType: "SetSceneItemEnabled",
        requestData: { sceneName: "BREAK", sceneItemId: 7, sceneItemEnabled: false },
      },
    ]);
  });

  it("a failing show/hide adds the overlay to missing and emits it", async () => {
    const missing: TextOverlayId[] = [];
    const client = new FakeObsClient({
      GetSceneItemId: () => {
        throw new Error("No scene item");
      },
    });
    const sync = new TextStyleObsSync({
      getClient: () => client,
      reportMissing: (ids) => {
        missing.splice(0, missing.length, ...ids);
      },
    });
    drive(sync, [{ type: "TOGGLE", id: "soldBanner" }]);
    await sync.idle();
    expect(missing).toContain("soldBanner");
  });

  it("Put the scenes back leaves Item Bar and SOLD enabled with the current item text", async () => {
    const { client, lastEnabled } = makeRestoreClient();
    let itemBar = initialItemBarState();
    itemBar = itemBarReducer(itemBar, { type: "SET_ITEM", item: "Vintage Mug", price: "$12" });
    itemBar = itemBarReducer(itemBar, { type: "SHOW" });
    itemBar = itemBarReducer(itemBar, { type: "SOLD", now: 1 });
    useAppStore.setState({ itemBar });

    const barSync = new ItemBarObsSync({ getClient: () => client });
    setItemBarObsSync(barSync);
    const sync = new TextStyleObsSync({ getClient: () => client });
    client.calls = [];

    await sync.restoreScenes(restoreConfig);

    const createItemBar = client.calls.find(
      (c) => c.requestType === "CreateInput" && c.requestData?.inputName === ITEM_BAR_SOURCE
    );
    expect((createItemBar?.requestData?.inputSettings as { text?: string })?.text).toBe(
      "Vintage Mug — $12"
    );
    expect(
      client.calls.some(
        (c) => c.requestType === "CreateInput" && c.requestData?.inputName === SOLD_BANNER_SOURCE
      )
    ).toBe(true);

    const createAndEnable = client.calls
      .filter(
        (c) =>
          c.requestType === "CreateInput" ||
          c.requestType === "SetSceneItemEnabled" ||
          c.requestType === "SetInputSettings"
      )
      .map((c) => c.requestType);
    expect(createAndEnable[0]).toBe("CreateInput");
    expect(createAndEnable).toContain("SetSceneItemEnabled");
    expect(createAndEnable).toContain("SetInputSettings");

    for (const sourceName of [ITEM_BAR_SOURCE, SOLD_BANNER_SOURCE]) {
      for (const sceneName of CAMERA_FACING_SCENES) {
        expect(lastEnabled.get(`${sceneName}\0${sourceName}`)).toBe(true);
      }
    }

    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetInputSettings" &&
          c.requestData?.inputName === ITEM_BAR_SOURCE &&
          (c.requestData.inputSettings as { text?: string })?.text === "Vintage Mug — $12"
      )
    ).toBe(true);
  });
});
