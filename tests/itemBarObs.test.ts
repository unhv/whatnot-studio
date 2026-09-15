import { describe, it, expect, beforeEach } from "vitest";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import {
  initialItemBarState,
  itemBarReducer,
  SOLD_BANNER_MS,
  type ItemBarAction,
  type ItemBarState,
} from "../src/state/itemBar.js";
import {
  ITEM_BAR_OBS_DEBOUNCE_MS,
  ItemBarObsSync,
  resetItemBarOverlayFlags,
  setItemBarObsSync,
  setItemBarOverlayFlags,
  useAppStore,
  type ItemBarObsClock,
} from "../src/state/store.js";
import {
  CAMERA_FACING_SCENES,
  ITEM_BAR_SOURCE,
  SOLD_BANNER_SOURCE,
  SOLD_BANNER_TEXT,
} from "../src/obs/sceneCompiler.js";

class ManualClock implements ItemBarObsClock {
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

function makeClient(): FakeObsClient {
  return new FakeObsClient({
    GetSceneItemId: () => ({ sceneItemId: 1 }),
    SetInputSettings: {},
    SetSceneItemEnabled: {},
  });
}

function canvasCalls(client: FakeObsClient) {
  return client.calls
    .filter((c) => c.requestType === "SetInputSettings" || c.requestType === "SetSceneItemEnabled")
    .map((c) => ({ requestType: c.requestType, requestData: c.requestData }));
}

function enableCalls(sourceName: string, enabled: boolean) {
  return CAMERA_FACING_SCENES.map((sceneName) => ({
    requestType: "SetSceneItemEnabled",
    requestData: { sceneName, sceneItemId: 1, sceneItemEnabled: enabled },
  }));
}

function drive(sync: ItemBarObsSync, actions: ItemBarAction[]): ItemBarState {
  let state = initialItemBarState();
  for (const action of actions) {
    const next = itemBarReducer(state, action);
    sync.notify(state, next);
    state = next;
  }
  return state;
}

describe("ItemBarObsSync", () => {
  beforeEach(() => {
    setItemBarObsSync(null);
    resetItemBarOverlayFlags();
    useAppStore.setState({ itemBar: initialItemBarState(), connectionStatus: "disconnected" });
  });

  it("SET_ITEM → SHOW → SOLD → expiry is SetInputSettings then SetSceneItemEnabled in that order", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = new ItemBarObsSync({ getClient: () => client, clock });

    let state = initialItemBarState();
    const step = (action: ItemBarAction) => {
      const next = itemBarReducer(state, action);
      sync.notify(state, next);
      state = next;
    };

    step({ type: "SET_ITEM", item: "Vintage Mug", price: "$12" });
    step({ type: "SHOW" });
    await sync.idle();
    step({ type: "SOLD", now: 1000 });
    await sync.idle();
    step({ type: "TICK", now: 1000 + SOLD_BANNER_MS });
    await sync.idle();

    expect(canvasCalls(client)).toEqual([
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: ITEM_BAR_SOURCE,
          inputSettings: { text: "Vintage Mug — $12" },
          overlay: true,
        },
      },
      ...enableCalls(ITEM_BAR_SOURCE, true),
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: SOLD_BANNER_SOURCE,
          inputSettings: { text: SOLD_BANNER_TEXT },
          overlay: true,
        },
      },
      ...enableCalls(SOLD_BANNER_SOURCE, true),
      ...enableCalls(ITEM_BAR_SOURCE, false),
      ...enableCalls(SOLD_BANNER_SOURCE, false),
    ]);
  });

  it("rapid typing produces one debounced SetInputSettings, not one per character", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = new ItemBarObsSync({
      getClient: () => client,
      clock,
      debounceMs: ITEM_BAR_OBS_DEBOUNCE_MS,
    });

    let state = initialItemBarState();
    for (const item of ["V", "Vi", "Vin", "Vint", "Vintage Mug"]) {
      const next = itemBarReducer(state, { type: "SET_ITEM", item, price: "$12" });
      sync.notify(state, next);
      state = next;
    }

    expect(canvasCalls(client)).toEqual([]);
    clock.advance(ITEM_BAR_OBS_DEBOUNCE_MS - 1);
    await sync.idle();
    expect(canvasCalls(client)).toEqual([]);

    clock.advance(1);
    await sync.idle();
    expect(canvasCalls(client)).toEqual([
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: ITEM_BAR_SOURCE,
          inputSettings: { text: "Vintage Mug — $12" },
          overlay: true,
        },
      },
    ]);
  });

  it("reducer and sync survive OBS being disconnected", async () => {
    const throwing = new FakeObsClient();
    throwing.call = async () => {
      throw new Error("not connected");
    };
    const sync = new ItemBarObsSync({ getClient: () => throwing });

    expect(() => {
      drive(sync, [
        { type: "SET_ITEM", item: "Mug", price: "$12" },
        { type: "SHOW" },
        { type: "SOLD", now: 1 },
        { type: "TICK", now: 1 + SOLD_BANNER_MS },
      ]);
    }).not.toThrow();
    await expect(sync.idle()).resolves.toBeUndefined();

    setItemBarObsSync(new ItemBarObsSync({ getClient: () => null }));
    expect(() => {
      useAppStore.getState().dispatchItemBar({ type: "SET_ITEM", item: "Mug", price: "$12" });
      useAppStore.getState().dispatchItemBar({ type: "SHOW" });
      useAppStore.getState().dispatchItemBar({ type: "SOLD", now: 50 });
    }).not.toThrow();
    expect(useAppStore.getState().itemBar.onCanvas).toBe(true);
    expect(useAppStore.getState().itemBar.item).toBe("Mug");
  });

  it("SHOW flushes a pending typed write immediately instead of waiting out the debounce", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const sync = new ItemBarObsSync({ getClient: () => client, clock });

    drive(sync, [
      { type: "SET_ITEM", item: "Mug", price: "$12" },
      { type: "SHOW" },
    ]);
    await sync.idle();
    expect(canvasCalls(client).filter((c) => c.requestType === "SetInputSettings")).toHaveLength(1);

    clock.advance(ITEM_BAR_OBS_DEBOUNCE_MS);
    await sync.idle();
    expect(canvasCalls(client).filter((c) => c.requestType === "SetInputSettings")).toHaveLength(1);
  });

  it("resync after connect pushes the current item without requiring another SHOW", async () => {
    const client = makeClient();
    const sync = new ItemBarObsSync({ getClient: () => client });
    let state = initialItemBarState();
    state = itemBarReducer(state, { type: "SET_ITEM", item: "Mug", price: "$12" });
    state = itemBarReducer(state, { type: "SHOW" });
    sync.resync(state);
    await sync.idle();
    expect(canvasCalls(client)).toEqual([
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: ITEM_BAR_SOURCE,
          inputSettings: { text: "Mug — $12" },
          overlay: true,
        },
      },
      ...enableCalls(ITEM_BAR_SOURCE, true),
      ...enableCalls(SOLD_BANNER_SOURCE, false),
    ]);
  });

  it("retries SetSceneItemEnabled after a stale cached scene item id", async () => {
    let currentId = 1;
    const client = new FakeObsClient({
      GetSceneItemId: () => ({ sceneItemId: currentId }),
      SetInputSettings: {},
      SetSceneItemEnabled: (data?: Record<string, unknown>) => {
        if (data?.sceneItemId === 1) {
          currentId = 42;
          throw new Error("stale scene item id");
        }
        return {};
      },
    });
    const sync = new ItemBarObsSync({ getClient: () => client });
    drive(sync, [
      { type: "SET_ITEM", item: "Mug", price: "$12" },
      { type: "SHOW" },
    ]);
    await sync.idle();

    const enables = client.calls.filter((c) => c.requestType === "SetSceneItemEnabled");
    expect(enables.some((c) => c.requestData?.sceneItemId === 1)).toBe(true);
    expect(enables.filter((c) => c.requestData?.sceneItemId === 42)).toHaveLength(CAMERA_FACING_SCENES.length);
    for (const sceneName of CAMERA_FACING_SCENES) {
      expect(enables).toContainEqual({
        requestType: "SetSceneItemEnabled",
        requestData: { sceneName, sceneItemId: 42, sceneItemEnabled: true },
      });
    }
  });

  it("drops a cached id when GetSceneItemId fails so the next lookup is live", async () => {
    let lookups = 0;
    const client = new FakeObsClient({
      GetSceneItemId: () => {
        lookups += 1;
        if (lookups === 1) throw new Error("source missing");
        return { sceneItemId: 9 };
      },
      SetInputSettings: {},
      SetSceneItemEnabled: {},
    });
    const sync = new ItemBarObsSync({ getClient: () => client });
    drive(sync, [
      { type: "SET_ITEM", item: "Mug", price: "$12" },
      { type: "SHOW" },
    ]);
    await sync.idle();

    expect(lookups).toBeGreaterThan(1);
    expect(
      client.calls.some(
        (c) => c.requestType === "SetSceneItemEnabled" && c.requestData?.sceneItemId === 9
      )
    ).toBe(true);
  });

  it("hiding the SOLD banner keeps it hidden across a SOLD press", async () => {
    const client = new FakeObsClient({
      GetSceneItemId: (data?: Record<string, unknown>) => ({
        sceneItemId: data?.sourceName === SOLD_BANNER_SOURCE ? 2 : 1,
      }),
      SetInputSettings: {},
      SetSceneItemEnabled: {},
    });
    const sync = new ItemBarObsSync({ getClient: () => client });
    setItemBarOverlayFlags({ itemBar: true, soldBanner: false });

    drive(sync, [
      { type: "SET_ITEM", item: "Mug", price: "$12" },
      { type: "SHOW" },
      { type: "SOLD", now: 1000 },
    ]);
    await sync.idle();

    expect(
      client.calls.filter(
        (c) =>
          c.requestType === "SetSceneItemEnabled" &&
          c.requestData?.sceneItemId === 2 &&
          c.requestData?.sceneItemEnabled === true
      )
    ).toEqual([]);
  });

  it("hiding the item bar keeps it hidden across a SHOW press", async () => {
    const client = new FakeObsClient({
      GetSceneItemId: (data?: Record<string, unknown>) => ({
        sceneItemId: data?.sourceName === ITEM_BAR_SOURCE ? 1 : 2,
      }),
      SetInputSettings: {},
      SetSceneItemEnabled: {},
    });
    const sync = new ItemBarObsSync({ getClient: () => client });
    setItemBarOverlayFlags({ itemBar: false, soldBanner: true });

    drive(sync, [
      { type: "SET_ITEM", item: "Mug", price: "$12" },
      { type: "SHOW" },
    ]);
    await sync.idle();

    expect(
      client.calls.filter(
        (c) =>
          c.requestType === "SetSceneItemEnabled" &&
          c.requestData?.sceneItemId === 1 &&
          c.requestData?.sceneItemEnabled === true
      )
    ).toEqual([]);
    expect(client.calls.filter((c) => c.requestType === "SetSceneItemEnabled")).toEqual([]);
  });
});
