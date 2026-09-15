/**
 * Seller-owned text placement/colour/size. Pure reducer + persistence + the
 * OBS writer. No React. LiveScreen mounts the preview and constructs the
 * sync; this file is unit-tested against FakeObsClient.
 */
import { syncScenes } from "../obs/applyPlan.js";
import type { ObsClient } from "../obs/client.js";
import {
  buildDesiredScenes,
  clampOverlayPosition,
  ITEM_BAR_SOURCE,
  nearestSnap,
  overlayInputSettings,
  overlaySceneNames,
  overlaySnapTransform,
  overlaySourceName,
  overlayStyleSettings,
  overlayTransformAt,
  SOLD_BANNER_SOURCE,
  TEXT_OVERLAY_IDS,
  type TextOverlayId,
  type TextSizeName,
  type TextSnapName,
} from "../obs/sceneCompiler.js";
import type { ShowConfig } from "../shared/types.js";
import {
  combinedItemBarEnabled,
  combinedSoldBannerEnabled,
  getItemBarObsSync,
  itemBarLine,
  resetItemBarOverlayFlags,
  setItemBarOverlayFlags,
  useAppStore,
} from "./store.js";

export const TEXT_STYLE_OBS_DEBOUNCE_MS = 200;
export const TEXT_STYLE_STORAGE_PREFIX = "whatnot-studio.textStyle.v1:";

export interface TextOverlayStyle {
  positionX: number;
  positionY: number;
  snap: TextSnapName | "custom";
  colorref: number;
  size: TextSizeName;
  visible: boolean;
}

export interface TextStyleState {
  overlays: Record<TextOverlayId, TextOverlayStyle>;
  missing: TextOverlayId[];
}

export const OVERLAY_LABELS: Record<TextOverlayId, string> = {
  itemBar: "Item name",
  soldBanner: "SOLD banner",
  breakCard: "Break card",
};

export function missingSourceMessage(ids: TextOverlayId[]): string {
  if (ids.length === 0) return "";
  const names = ids.map((id) => OVERLAY_LABELS[id]);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const verb = ids.length === 1 ? "isn't" : "aren't";
  return `${list} ${verb} on the canvas. It was probably deleted in OBS. Put the scenes back?`;
}

export function defaultOverlayStyle(id: TextOverlayId): TextOverlayStyle {
  const snap: TextSnapName = id === "itemBar" ? "safe" : "middle";
  const t = overlaySnapTransform(id, snap, "normal");
  return {
    positionX: t.positionX,
    positionY: t.positionY,
    snap,
    colorref: id === "soldBanner" ? 0x0028c8ff : 0xffffff,
    size: "normal",
    visible: true,
  };
}

export function initialTextStyleState(): TextStyleState {
  return {
    overlays: {
      itemBar: defaultOverlayStyle("itemBar"),
      soldBanner: defaultOverlayStyle("soldBanner"),
      breakCard: defaultOverlayStyle("breakCard"),
    },
    missing: [],
  };
}

export type TextStyleAction =
  | { type: "DRAG"; id: TextOverlayId; x: number; y: number }
  | { type: "DROP"; id: TextOverlayId; x: number; y: number }
  | { type: "SNAP"; id: TextOverlayId; snap: TextSnapName }
  | { type: "COLOR"; id: TextOverlayId; colorref: number }
  | { type: "SIZE"; id: TextOverlayId; size: TextSizeName }
  | { type: "TOGGLE"; id: TextOverlayId }
  | { type: "SET_VISIBLE"; id: TextOverlayId; visible: boolean }
  | { type: "MISSING"; ids: TextOverlayId[] }
  | { type: "REHYDRATE"; state: TextStyleState };

export function textStyleReducer(state: TextStyleState, action: TextStyleAction): TextStyleState {
  switch (action.type) {
    case "DRAG": {
      const cur = state.overlays[action.id];
      const clamped = clampOverlayPosition(action.id, cur.size, action.x, action.y);
      return patchOverlay(state, action.id, {
        positionX: clamped.x,
        positionY: clamped.y,
        snap: "custom",
      });
    }
    case "DROP": {
      const cur = state.overlays[action.id];
      const clamped = clampOverlayPosition(action.id, cur.size, action.x, action.y);
      const snapped = nearestSnap(action.id, cur.size, clamped.x, clamped.y);
      return patchOverlay(state, action.id, {
        positionX: snapped.positionX,
        positionY: snapped.positionY,
        snap: snapped.snap,
      });
    }
    case "SNAP": {
      const cur = state.overlays[action.id];
      const t = overlaySnapTransform(action.id, action.snap, cur.size);
      return patchOverlay(state, action.id, {
        snap: action.snap,
        positionX: t.positionX,
        positionY: t.positionY,
      });
    }
    case "COLOR":
      return patchOverlay(state, action.id, { colorref: action.colorref });
    case "SIZE": {
      const cur = state.overlays[action.id];
      if (cur.snap !== "custom") {
        const t = overlaySnapTransform(action.id, cur.snap, action.size);
        return patchOverlay(state, action.id, {
          size: action.size,
          positionX: t.positionX,
          positionY: t.positionY,
        });
      }
      const clamped = clampOverlayPosition(action.id, action.size, cur.positionX, cur.positionY);
      return patchOverlay(state, action.id, {
        size: action.size,
        positionX: clamped.x,
        positionY: clamped.y,
      });
    }
    case "TOGGLE":
      return patchOverlay(state, action.id, { visible: !state.overlays[action.id].visible });
    case "SET_VISIBLE":
      return patchOverlay(state, action.id, { visible: action.visible });
    case "MISSING":
      return { ...state, missing: [...action.ids] };
    case "REHYDRATE":
      return {
        overlays: {
          itemBar: { ...defaultOverlayStyle("itemBar"), ...action.state.overlays.itemBar },
          soldBanner: { ...defaultOverlayStyle("soldBanner"), ...action.state.overlays.soldBanner },
          breakCard: { ...defaultOverlayStyle("breakCard"), ...action.state.overlays.breakCard },
        },
        missing: action.state.missing ?? [],
      };
    default:
      return state;
  }
}

function patchOverlay(
  state: TextStyleState,
  id: TextOverlayId,
  patch: Partial<TextOverlayStyle>
): TextStyleState {
  return {
    ...state,
    overlays: { ...state.overlays, [id]: { ...state.overlays[id], ...patch } },
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let injectedStorage: StorageLike | null | undefined;

export function setTextStyleStorage(storage: StorageLike | null | undefined): void {
  injectedStorage = storage;
}

export function textStyleStorageKey(showName: string): string {
  return `${TEXT_STYLE_STORAGE_PREFIX}${showName.trim()}`;
}

function resolveStorage(): StorageLike | null {
  if (injectedStorage !== undefined) return injectedStorage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // private mode / node
  }
  return null;
}

export function persistTextStyle(showName: string, state: TextStyleState, storage?: StorageLike | null): void {
  const store = storage === undefined ? resolveStorage() : storage;
  if (!store) return;
  try {
    store.setItem(textStyleStorageKey(showName), JSON.stringify({ v: 1, overlays: state.overlays }));
  } catch {
    // quota / private mode — settings stay in memory for this session
  }
}

export function loadTextStyle(showName: string, storage?: StorageLike | null): TextStyleState {
  const store = storage === undefined ? resolveStorage() : storage;
  const fallback = initialTextStyleState();
  if (!store) return fallback;
  try {
    const raw = store.getItem(textStyleStorageKey(showName));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { v?: number; overlays?: Partial<Record<TextOverlayId, Partial<TextOverlayStyle>>> };
    if (!parsed || parsed.v !== 1 || !parsed.overlays) return fallback;
    return textStyleReducer(fallback, {
      type: "REHYDRATE",
      state: {
        overlays: {
          itemBar: { ...fallback.overlays.itemBar, ...parsed.overlays.itemBar },
          soldBanner: { ...fallback.overlays.soldBanner, ...parsed.overlays.soldBanner },
          breakCard: { ...fallback.overlays.breakCard, ...parsed.overlays.breakCard },
        },
        missing: [],
      },
    });
  } catch {
    return fallback;
  }
}

export interface TextStyleClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: TextStyleClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export type TextStyleWriteReason = "drag" | "commit";

export interface TextStyleObsSyncOpts {
  getClient: () => ObsClient | null;
  isConnected?: () => boolean;
  debounceMs?: number;
  clock?: TextStyleClock;
  reportMissing?: (ids: TextOverlayId[]) => void;
}

/**
 * Pushes text-style state to OBS. Transforms flush on commit (snap/drop);
 * drags are debounced so a finger-slide is one write, not one per pixel.
 * Colour and size go out as SetInputSettings, also debounced.
 * Every OBS call is swallowed on failure so a missing socket never throws.
 */
export class TextStyleObsSync {
  private readonly debounceMs: number;
  private readonly clock: TextStyleClock;
  private transformTimer: unknown = null;
  private settingsTimer: unknown = null;
  private pendingTransform: TextStyleState | undefined;
  private pendingSettings: TextStyleState | undefined;
  private pendingTransformIds = new Set<TextOverlayId>();
  private pendingEnabledIds = new Set<TextOverlayId>();
  private chain: Promise<void> = Promise.resolve();
  private idCache = new Map<string, number>();
  private lastState: TextStyleState;
  private missing = new Set<TextOverlayId>();

  constructor(private readonly opts: TextStyleObsSyncOpts) {
    this.debounceMs = opts.debounceMs ?? TEXT_STYLE_OBS_DEBOUNCE_MS;
    this.clock = opts.clock ?? realClock;
    this.lastState = initialTextStyleState();
    this.publishOverlayFlags(this.lastState);
  }

  idle(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    this.clearTransformTimer();
    this.clearSettingsTimer();
    this.pendingTransform = undefined;
    this.pendingSettings = undefined;
    this.pendingTransformIds.clear();
    this.pendingEnabledIds.clear();
    this.idCache.clear();
    resetItemBarOverlayFlags();
  }

  notify(prev: TextStyleState, next: TextStyleState, reason: TextStyleWriteReason = "commit"): void {
    if (prev === next) return;
    this.lastState = next;
    this.publishOverlayFlags(next);

    let transformChanged = false;
    let settingsChanged = false;
    let enabledChanged = false;
    for (const id of TEXT_OVERLAY_IDS) {
      const a = prev.overlays[id];
      const b = next.overlays[id];
      if (a.positionX !== b.positionX || a.positionY !== b.positionY || a.size !== b.size) {
        this.pendingTransformIds.add(id);
        transformChanged = true;
      }
      if (a.colorref !== b.colorref || a.size !== b.size) {
        settingsChanged = true;
      }
      if (a.visible !== b.visible) {
        this.pendingEnabledIds.add(id);
        enabledChanged = true;
      }
    }

    if (transformChanged) {
      this.pendingTransform = next;
      if (reason === "drag") this.scheduleTransformWrite();
      else {
        this.clearTransformTimer();
        this.enqueue(() => this.flushTransform());
      }
    }

    if (enabledChanged) {
      this.enqueue(async () => {
        await this.flushEnabled(next, false);
        this.emitMissing();
      });
    }

    if (settingsChanged) {
      this.pendingSettings = next;
      this.scheduleSettingsWrite();
    }
  }

  /** Push whatever we last held — used when the socket comes back. */
  resync(state: TextStyleState): void {
    this.lastState = state;
    this.publishOverlayFlags(state);
    this.clearTransformTimer();
    this.clearSettingsTimer();
    this.pendingTransform = state;
    this.pendingSettings = state;
    for (const id of TEXT_OVERLAY_IDS) this.pendingTransformIds.add(id);
    this.enqueue(async () => {
      this.missing.clear();
      await this.flushTransform();
      await this.flushSettings();
      await this.flushEnabled(state, true);
      this.emitMissing();
    });
  }

  async restoreScenes(config: ShowConfig): Promise<void> {
    const client = this.readyClient();
    if (!client) return;
    try {
      const itemBar = useAppStore.getState().itemBar;
      const overlays = this.lastState.overlays;
      const desired = buildDesiredScenes(config, { breakCard: overlays.breakCard.visible });
      const line = itemBarLine(itemBar) ?? "";
      for (const scene of desired) {
        for (const item of scene.items) {
          if (item.sourceName === ITEM_BAR_SOURCE) {
            item.inputSettings = { ...item.inputSettings, text: line };
            item.enabled = combinedItemBarEnabled(itemBar, overlays.itemBar.visible);
          }
          if (item.sourceName === SOLD_BANNER_SOURCE) {
            item.enabled = combinedSoldBannerEnabled(itemBar, overlays.soldBanner.visible);
          }
        }
      }
      await syncScenes(client, desired);
      this.idCache.clear();
      this.resync(this.lastState);
      getItemBarObsSync()?.resync(itemBar);
      await this.idle();
      await getItemBarObsSync()?.idle();
    } catch {
      // disconnected or OBS refused — UI must not throw
    }
  }

  private scheduleTransformWrite(): void {
    this.clearTransformTimer();
    this.transformTimer = this.clock.setTimeout(() => {
      this.transformTimer = null;
      this.enqueue(() => this.flushTransform());
    }, this.debounceMs);
  }

  private scheduleSettingsWrite(): void {
    this.clearSettingsTimer();
    this.settingsTimer = this.clock.setTimeout(() => {
      this.settingsTimer = null;
      this.enqueue(() => this.flushSettings());
    }, this.debounceMs);
  }

  private clearTransformTimer(): void {
    if (this.transformTimer !== null && this.transformTimer !== undefined) {
      this.clock.clearTimeout(this.transformTimer);
      this.transformTimer = null;
    }
  }

  private clearSettingsTimer(): void {
    if (this.settingsTimer !== null && this.settingsTimer !== undefined) {
      this.clock.clearTimeout(this.settingsTimer);
      this.settingsTimer = null;
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work, work).catch(() => {});
  }

  private async flushTransform(): Promise<void> {
    this.clearTransformTimer();
    const state = this.pendingTransform;
    if (!state) return;
    this.pendingTransform = undefined;
    const ids = [...this.pendingTransformIds];
    this.pendingTransformIds.clear();
    for (const id of ids) {
      const overlay = state.overlays[id];
      const transform = overlayTransformAt(overlay.positionX, overlay.positionY);
      await this.setTransform(id, transform);
    }
    this.emitMissing();
  }

  /**
   * Scene-item enabled is the AND of this toggle and the item-bar owner.
   * Both paths write the same combined value so SHOW/SOLD cannot un-hide
   * a source the seller turned off here, and a hide cannot turn on an
   * empty Item Bar.
   */
  private async flushEnabled(state: TextStyleState, reconnect: boolean): Promise<void> {
    const ids = reconnect ? [...TEXT_OVERLAY_IDS] : [...this.pendingEnabledIds];
    this.pendingEnabledIds.clear();
    for (const id of ids) {
      await this.setEnabled(id, this.combinedEnabled(id, state));
    }
  }

  private combinedEnabled(id: TextOverlayId, state: TextStyleState): boolean {
    const overlay = state.overlays[id];
    if (id === "breakCard") return overlay.visible;
    const itemBar = useAppStore.getState().itemBar;
    if (id === "itemBar") return combinedItemBarEnabled(itemBar, overlay.visible);
    return combinedSoldBannerEnabled(itemBar, overlay.visible);
  }

  private publishOverlayFlags(state: TextStyleState): void {
    setItemBarOverlayFlags({
      itemBar: state.overlays.itemBar.visible,
      soldBanner: state.overlays.soldBanner.visible,
    });
  }

  private async flushSettings(): Promise<void> {
    this.clearSettingsTimer();
    const state = this.pendingSettings;
    if (!state) return;
    this.pendingSettings = undefined;
    for (const id of TEXT_OVERLAY_IDS) {
      const overlay = state.overlays[id];
      await this.setStyle(id, overlay.colorref, overlay.size);
    }
    this.emitMissing();
  }

  private readyClient(): ObsClient | null {
    const client = this.opts.getClient();
    if (!client) return null;
    if (this.opts.isConnected && !this.opts.isConnected()) return null;
    return client;
  }

  private async setStyle(id: TextOverlayId, colorref: number, size: TextSizeName): Promise<void> {
    const client = this.readyClient();
    if (!client) return;
    const inputName = overlaySourceName(id);
    try {
      await client.call("SetInputSettings", {
        inputName,
        inputSettings: overlayStyleSettings(id, { colorref, size }),
        overlay: true,
      });
      this.missing.delete(id);
    } catch {
      if (this.readyClient()) this.missing.add(id);
    }
  }

  private async setTransform(
    id: TextOverlayId,
    transform: ReturnType<typeof overlayTransformAt>
  ): Promise<void> {
    const client = this.readyClient();
    if (!client) return;
    const sourceName = overlaySourceName(id);
    let anyOk = false;
    for (const sceneName of overlaySceneNames(id)) {
      try {
        await this.writeTransform(client, sceneName, sourceName, transform);
        anyOk = true;
      } catch {
        // try remaining scenes
      }
    }
    if (anyOk) this.missing.delete(id);
    else if (this.readyClient()) this.missing.add(id);
  }

  private async setEnabled(id: TextOverlayId, enabled: boolean): Promise<void> {
    const client = this.readyClient();
    if (!client) return;
    const sourceName = overlaySourceName(id);
    let anyOk = false;
    for (const sceneName of overlaySceneNames(id)) {
      try {
        await this.toggleSceneItem(client, sceneName, sourceName, enabled);
        anyOk = true;
      } catch {
        // try remaining scenes
      }
    }
    if (anyOk) this.missing.delete(id);
    else if (this.readyClient()) this.missing.add(id);
  }

  private cacheKey(sceneName: string, sourceName: string): string {
    return `${sceneName}\0${sourceName}`;
  }

  private async writeTransform(
    client: ObsClient,
    sceneName: string,
    sourceName: string,
    transform: ReturnType<typeof overlayTransformAt>
  ): Promise<void> {
    const key = this.cacheKey(sceneName, sourceName);
    try {
      const sceneItemId = await this.resolveItemId(client, sceneName, sourceName);
      await client.call("SetSceneItemTransform", {
        sceneName,
        sceneItemId,
        sceneItemTransform: transform,
      });
    } catch {
      this.idCache.delete(key);
      const sceneItemId = await this.resolveItemId(client, sceneName, sourceName);
      await client.call("SetSceneItemTransform", {
        sceneName,
        sceneItemId,
        sceneItemTransform: transform,
      });
    }
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

  private emitMissing(): void {
    this.opts.reportMissing?.([...this.missing]);
  }
}

/** Kept so tests can assert the compile-time defaults still match the runtime writer. */
export function settingsForOverlay(id: TextOverlayId, style: TextOverlayStyle): Record<string, unknown> {
  return overlayInputSettings(id, { colorref: style.colorref, size: style.size });
}
