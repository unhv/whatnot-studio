/**
 * The one Zustand store for the whole app (brief: "one window, one store,
 * no router"). UI/session state only — the pure logic it calls into
 * (itemBarReducer, buildDesiredScenes, deriveLiveState, ...) lives in
 * src/obs and src/state/itemBar.ts and is unit-tested independently of
 * this store.
 *
 * Item-bar OBS push lives here so dispatchItemBar is the single place the
 * reducer result is forwarded to SetInputSettings / SetSceneItemEnabled.
 * The renderer still owns the websocket client and the TICK interval.
 */
import { create } from "zustand";
import { SCENE_KEYS, type SceneKey, type ShowConfig } from "../shared/types.js";
import { initialItemBarState, itemBarReducer, type ItemBarAction, type ItemBarState } from "./itemBar.js";
import { initialDeviceEnum, type DeviceEnumState } from "./setupDevices.js";
import {
  deriveLiveState,
  deriveSocketDisconnect,
  initialLiveState,
  type LiveState,
  type StreamStateChangedEvent,
} from "../obs/liveMode.js";
import type { ObsClient } from "../obs/client.js";
import {
  CAMERA_FACING_SCENES,
  ITEM_BAR_SOURCE,
  SOLD_BANNER_SOURCE,
  SOLD_BANNER_TEXT,
} from "../obs/sceneCompiler.js";

export type Screen = "setup" | "live";

export interface AppState {
  screen: Screen;
  showConfig: ShowConfig;
  activeScene: SceneKey;
  micMuted: boolean;
  itemBar: ItemBarState;
  live: LiveState;
  connectionStatus: "disconnected" | "connecting" | "connected" | "error";
  /** Setup-screen OBS device list. Independent of live.connectionStatus
   * so enumerating on Setup cannot clobber the LIVE screen's socket flag. */
  deviceEnum: DeviceEnumState;

  setShowConfig(config: Partial<ShowConfig>): void;
  setDeviceEnum(enumState: DeviceEnumState): void;
  goToLive(): void;
  goToSetup(): void;
  setActiveScene(scene: SceneKey): void;
  setMicMuted(muted: boolean): void;
  dispatchItemBar(action: ItemBarAction): void;
  /** Fold one StreamStateChanged event. Never replace LiveState wholesale
   * — deriveLiveState needs `prev` so RECONNECTING stays live. */
  applyStreamStateChanged(event: StreamStateChangedEvent, now?: number): void;
  /** Losing obs-websocket is not the show ending. */
  applySocketDisconnect(now?: number): void;
  setConnectionStatus(status: AppState["connectionStatus"]): void;
}

export const DEFAULT_SHOW_CONFIG: ShowConfig = {
  showName: "",
  camera: null,
  mic: null,
  captureCard: null,
  // Filled at runtime from OBS's own websocket config. Memory only —
  // persistableShowConfig blanks this so it is never written as plain JSON.
  obsPassword: "",
  obsPort: 4455,
};

/** Drop the OBS websocket password before any disk/JSON snapshot. */
export function persistableShowConfig(config: ShowConfig): ShowConfig {
  return { ...config, obsPassword: "" };
}

/** ~one beat. Fast enough to feel live, slow enough not to hammer the socket per keystroke. */
export const ITEM_BAR_OBS_DEBOUNCE_MS = 200;

export interface ItemBarObsClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: ItemBarObsClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface ItemBarObsSyncOpts {
  getClient: () => ObsClient | null;
  /** When omitted, a non-null client is treated as ready. */
  isConnected?: () => boolean;
  debounceMs?: number;
  clock?: ItemBarObsClock;
}

export function itemBarLine(state: ItemBarState): string | null {
  if (state.item.trim() === "") return null;
  return `${state.item} — ${state.price}`;
}

/** Item-bar SHOW/CLEAR owner: the line is on canvas. */
export function itemBarCanvasVisible(state: ItemBarState): boolean {
  return state.onCanvas && state.item.trim() !== "";
}

/** Item-bar SOLD owner: the banner's timer is running. */
export function soldBannerCanvasVisible(state: ItemBarState): boolean {
  return state.soldUntil !== null;
}

/** Seller hide-toggle for the two sources the item-bar path also owns.
 * TextStyleObsSync publishes this; SHOW/SOLD/F5 read it so both writers
 * push the AND of the two owners. */
export interface ItemBarOverlayFlags {
  itemBar: boolean;
  soldBanner: boolean;
}

const DEFAULT_ITEM_BAR_OVERLAY_FLAGS: ItemBarOverlayFlags = { itemBar: true, soldBanner: true };

let itemBarOverlayFlags: ItemBarOverlayFlags = { ...DEFAULT_ITEM_BAR_OVERLAY_FLAGS };

export function setItemBarOverlayFlags(flags: ItemBarOverlayFlags): void {
  itemBarOverlayFlags = { itemBar: flags.itemBar, soldBanner: flags.soldBanner };
}

export function getItemBarOverlayFlags(): ItemBarOverlayFlags {
  return itemBarOverlayFlags;
}

export function resetItemBarOverlayFlags(): void {
  itemBarOverlayFlags = { ...DEFAULT_ITEM_BAR_OVERLAY_FLAGS };
}

export function combinedItemBarEnabled(state: ItemBarState, overlayVisible: boolean): boolean {
  return itemBarCanvasVisible(state) && overlayVisible;
}

export function combinedSoldBannerEnabled(state: ItemBarState, overlayVisible: boolean): boolean {
  return soldBannerCanvasVisible(state) && overlayVisible;
}

/**
 * Pushes item-bar state to OBS. Text writes are debounced; show/hide of
 * the Item Bar and SOLD Banner sources is immediate. Every OBS call is
 * swallowed on failure so a missing socket never throws into the UI.
 */
export class ItemBarObsSync {
  private readonly debounceMs: number;
  private readonly clock: ItemBarObsClock;
  private timer: unknown = null;
  private pendingText: string | undefined;
  private chain: Promise<void> = Promise.resolve();
  private idCache = new Map<string, number>();

  constructor(private readonly opts: ItemBarObsSyncOpts) {
    this.debounceMs = opts.debounceMs ?? ITEM_BAR_OBS_DEBOUNCE_MS;
    this.clock = opts.clock ?? realClock;
  }

  /** Drain in-flight OBS writes — tests await this after notify / clock.advance. */
  idle(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    this.clearTimer();
    this.pendingText = undefined;
    this.idCache.clear();
  }

  notify(prev: ItemBarState, next: ItemBarState): void {
    if (prev === next) return;

    const prevLine = itemBarLine(prev);
    const nextLine = itemBarLine(next);
    const visChanged =
      itemBarCanvasVisible(prev) !== itemBarCanvasVisible(next) ||
      soldBannerCanvasVisible(prev) !== soldBannerCanvasVisible(next);

    if (nextLine === null) {
      this.pendingText = undefined;
      this.clearTimer();
    } else if (nextLine !== prevLine) {
      this.pendingText = nextLine;
      if (!visChanged) this.scheduleTextWrite();
    }

    if (visChanged) {
      this.enqueue(async () => {
        await this.flushText();
        await this.syncVisibility(prev, next);
      });
    }
  }

  /** Push whatever the store currently holds — used when the socket comes back. */
  resync(state: ItemBarState): void {
    this.clearTimer();
    const line = itemBarLine(state);
    this.pendingText = line ?? undefined;
    this.enqueue(async () => {
      await this.flushText();
      // Force both flags so a reconnect matches the store, not our last guess.
      await this.syncVisibility(initialItemBarState(), state, true);
    });
  }

  private scheduleTextWrite(): void {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.enqueue(() => this.flushText());
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null && this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work, work).catch(() => {});
  }

  private async flushText(): Promise<void> {
    this.clearTimer();
    if (this.pendingText === undefined) return;
    const text = this.pendingText;
    this.pendingText = undefined;
    await this.setInputText(ITEM_BAR_SOURCE, text);
  }

  private async syncVisibility(prev: ItemBarState, next: ItemBarState, force = false): Promise<void> {
    const flags = getItemBarOverlayFlags();
    const showItem = combinedItemBarEnabled(next, flags.itemBar);
    const showSold = combinedSoldBannerEnabled(next, flags.soldBanner);
    const wasItem = combinedItemBarEnabled(prev, flags.itemBar);
    const wasSold = combinedSoldBannerEnabled(prev, flags.soldBanner);
    if (showSold && !soldBannerCanvasVisible(prev)) {
      await this.setInputText(SOLD_BANNER_SOURCE, SOLD_BANNER_TEXT);
    }
    if (force || wasItem !== showItem) {
      await this.setSourceEnabled(ITEM_BAR_SOURCE, showItem);
    }
    if (force || wasSold !== showSold) {
      await this.setSourceEnabled(SOLD_BANNER_SOURCE, showSold);
    }
  }

  private readyClient(): ObsClient | null {
    const client = this.opts.getClient();
    if (!client) return null;
    if (this.opts.isConnected && !this.opts.isConnected()) return null;
    return client;
  }

  private async setInputText(inputName: string, text: string): Promise<void> {
    const client = this.readyClient();
    if (!client) return;
    try {
      await client.call("SetInputSettings", {
        inputName,
        inputSettings: { text },
        overlay: true,
      });
    } catch {
      // disconnected or source missing — UI must not throw
    }
  }

  private async setSourceEnabled(sourceName: string, enabled: boolean): Promise<void> {
    const client = this.readyClient();
    if (!client) return;
    for (const sceneName of CAMERA_FACING_SCENES) {
      try {
        await this.toggleSceneItem(client, sceneName, sourceName, enabled);
      } catch {
        // disconnected or source missing — UI must not throw
      }
    }
  }

  private cacheKey(sceneName: string, sourceName: string): string {
    return `${sceneName}\0${sourceName}`;
  }

  private async toggleSceneItem(
    client: ObsClient,
    sceneName: string,
    sourceName: string,
    enabled: boolean
  ): Promise<void> {
    const key = this.cacheKey(sceneName, sourceName);
    try {
      const sceneItemId = await this.resolveItemId(client, sceneName, sourceName);
      await client.call("SetSceneItemEnabled", {
        sceneName,
        sceneItemId,
        sceneItemEnabled: enabled,
      });
    } catch {
      // Recreating the source in OBS changes the item id; the cache then
      // aims SetSceneItemEnabled at a dead id. Drop it and look up once more.
      this.idCache.delete(key);
      const sceneItemId = await this.resolveItemId(client, sceneName, sourceName);
      await client.call("SetSceneItemEnabled", {
        sceneName,
        sceneItemId,
        sceneItemEnabled: enabled,
      });
    }
  }

  private async resolveItemId(client: ObsClient, sceneName: string, sourceName: string): Promise<number> {
    const key = this.cacheKey(sceneName, sourceName);
    const cached = this.idCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const res = await client.call<{ sceneItemId: number }>("GetSceneItemId", { sceneName, sourceName });
      this.idCache.set(key, res.sceneItemId);
      return res.sceneItemId;
    } catch (err) {
      this.idCache.delete(key);
      throw err;
    }
  }
}

let itemBarObsSync: ItemBarObsSync | null = null;

export function setItemBarObsSync(sync: ItemBarObsSync | null): void {
  itemBarObsSync = sync;
}

export function getItemBarObsSync(): ItemBarObsSync | null {
  return itemBarObsSync;
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: "setup",
  showConfig: DEFAULT_SHOW_CONFIG,
  activeScene: SCENE_KEYS[0],
  micMuted: false,
  itemBar: initialItemBarState(),
  live: initialLiveState(Date.now()),
  connectionStatus: "disconnected",
  deviceEnum: initialDeviceEnum(),

  setShowConfig: (config) => set((s) => ({ showConfig: { ...s.showConfig, ...config } })),
  setDeviceEnum: (deviceEnum) => set({ deviceEnum }),
  goToLive: () => set({ screen: "live" }),
  goToSetup: () =>
    set((s) => (s.live.live ? s : { screen: "setup" })), // "Setup" link is disabled while LIVE
  setActiveScene: (scene) => set({ activeScene: scene }),
  setMicMuted: (muted) => set({ micMuted: muted }),
  dispatchItemBar: (action) => {
    const prev = get().itemBar;
    const next = itemBarReducer(prev, action);
    set({ itemBar: next });
    itemBarObsSync?.notify(prev, next);
  },
  applyStreamStateChanged: (event, now = Date.now()) =>
    set((s) => ({ live: deriveLiveState(s.live, event, now) })),
  applySocketDisconnect: (now = Date.now()) =>
    set((s) => ({ live: deriveSocketDisconnect(s.live, now) })),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
