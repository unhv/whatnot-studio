/**
 * Named two-camera layouts for the BOTH scene. Pure geometry + a reducer
 * + injectable persistence. OBS writes live in CameraLayoutObsSync so a
 * missing socket never throws into the UI.
 */
import { computeCropToFill } from "../../spike/lib.js";
import type { ObsClient } from "../obs/client.js";
import {
  ASSUMED_SOURCE_HEIGHT,
  ASSUMED_SOURCE_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type ShowConfig,
} from "../shared/types.js";

export const CAMERA_LAYOUT_SETTINGS_KEY = "whatnot-studio-camera-layout";

/** Same beat as the item-bar text push: live enough, not per-pixel. */
export const CAMERA_LAYOUT_OBS_DEBOUNCE_MS = 200;

export const LAYOUT_KINDS = ["inset", "split"] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

export const INSET_SIZES = ["small", "medium", "large"] as const;
export type InsetSize = (typeof INSET_SIZES)[number];

export const CAMERA_SLOTS = ["table", "webcam"] as const;
export type CameraSlot = (typeof CAMERA_SLOTS)[number];

export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type Corner = (typeof CORNERS)[number];

/**
 * Keep-clear region on the 1080×1920 canvas so the inset is not under
 * Whatnot's own viewer chrome (live/follow along the top, bid/buy card
 * along the bottom). Side values match the original 24px pad.
 */
export const WHATNOT_SAFE = {
  left: 24,
  right: 24,
  top: 176,
  bottom: 304,
} as const;

/** Corner snap, in canvas pixels. ~24px on the 270px-wide preview. */
export const SNAP_DISTANCE_PX = 96;

export const INSET_WIDTH_FRAC: Record<InsetSize, number> = {
  small: 0.32,
  medium: 0.5,
  large: 0.68,
};

export interface LayoutTransform {
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
}

export interface CameraLayout {
  kind: LayoutKind;
  main: CameraSlot;
  insetSize: InsetSize;
  insetX: number;
  insetY: number;
}

export interface CameraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function insetSizePx(size: InsetSize): { w: number; h: number } {
  const w = Math.round(CANVAS_WIDTH * INSET_WIDTH_FRAC[size]);
  const h = Math.round(w * (CANVAS_HEIGHT / CANVAS_WIDTH));
  return { w, h };
}

export function safeRect(): CameraRect {
  return {
    x: WHATNOT_SAFE.left,
    y: WHATNOT_SAFE.top,
    w: CANVAS_WIDTH - WHATNOT_SAFE.left - WHATNOT_SAFE.right,
    h: CANVAS_HEIGHT - WHATNOT_SAFE.top - WHATNOT_SAFE.bottom,
  };
}

export function clampInset(x: number, y: number, size: InsetSize): { x: number; y: number } {
  const { w, h } = insetSizePx(size);
  const s = safeRect();
  const maxX = s.x + s.w - w;
  const maxY = s.y + s.h - h;
  return {
    x: Math.min(Math.max(Math.round(x), s.x), Math.max(s.x, maxX)),
    y: Math.min(Math.max(Math.round(y), s.y), Math.max(s.y, maxY)),
  };
}

export function cornerPosition(corner: Corner, size: InsetSize): { x: number; y: number } {
  const { w, h } = insetSizePx(size);
  const s = safeRect();
  switch (corner) {
    case "top-left":
      return { x: s.x, y: s.y };
    case "top-right":
      return { x: s.x + s.w - w, y: s.y };
    case "bottom-left":
      return { x: s.x, y: s.y + s.h - h };
    case "bottom-right":
      return { x: s.x + s.w - w, y: s.y + s.h - h };
  }
}

export function nearestCorner(
  x: number,
  y: number,
  size: InsetSize
): { corner: Corner; x: number; y: number; dist: number } | null {
  let best: { corner: Corner; x: number; y: number; dist: number } | null = null;
  for (const corner of CORNERS) {
    const pos = cornerPosition(corner, size);
    const dist = Math.hypot(x - pos.x, y - pos.y);
    if (dist <= SNAP_DISTANCE_PX && (best === null || dist < best.dist)) {
      best = { corner, x: pos.x, y: pos.y, dist };
    }
  }
  return best;
}

export function defaultCameraLayout(): CameraLayout {
  const insetSize: InsetSize = "small";
  const pos = cornerPosition("bottom-right", insetSize);
  return {
    kind: "inset",
    main: "table",
    insetSize,
    insetX: pos.x,
    insetY: pos.y,
  };
}

export const DEFAULT_CAMERA_LAYOUT: CameraLayout = defaultCameraLayout();

export type CameraLayoutAction =
  | { type: "SET_KIND"; kind: LayoutKind }
  | { type: "SET_SIZE"; size: InsetSize }
  | { type: "SWAP" }
  | { type: "MOVE_INSET"; x: number; y: number }
  | { type: "END_DRAG" }
  | { type: "SNAP"; corner: Corner }
  | { type: "HYDRATE"; layout: CameraLayout };

export function cameraLayoutReducer(state: CameraLayout, action: CameraLayoutAction): CameraLayout {
  switch (action.type) {
    case "SET_KIND":
      return { ...state, kind: action.kind };
    case "SET_SIZE": {
      const pos = clampInset(state.insetX, state.insetY, action.size);
      return { ...state, insetSize: action.size, insetX: pos.x, insetY: pos.y };
    }
    case "SWAP":
      return { ...state, main: state.main === "table" ? "webcam" : "table" };
    case "MOVE_INSET": {
      const pos = clampInset(action.x, action.y, state.insetSize);
      return { ...state, kind: "inset", insetX: pos.x, insetY: pos.y };
    }
    case "END_DRAG": {
      const snap = nearestCorner(state.insetX, state.insetY, state.insetSize);
      if (!snap) return state;
      return { ...state, insetX: snap.x, insetY: snap.y };
    }
    case "SNAP": {
      const pos = cornerPosition(action.corner, state.insetSize);
      return { ...state, kind: "inset", insetX: pos.x, insetY: pos.y };
    }
    case "HYDRATE":
      return parseCameraLayout(action.layout);
    default:
      return state;
  }
}

function isLayoutKind(value: unknown): value is LayoutKind {
  return LAYOUT_KINDS.some((k) => k === value);
}
function isInsetSize(value: unknown): value is InsetSize {
  return INSET_SIZES.some((s) => s === value);
}
function isCameraSlot(value: unknown): value is CameraSlot {
  return CAMERA_SLOTS.some((s) => s === value);
}

export function parseCameraLayout(raw: unknown): CameraLayout {
  const base = defaultCameraLayout();
  if (raw === null || typeof raw !== "object") return base;
  const rec = raw as Record<string, unknown>;
  const insetSize = isInsetSize(rec.insetSize) ? rec.insetSize : base.insetSize;
  const pos = clampInset(
    typeof rec.insetX === "number" && Number.isFinite(rec.insetX) ? rec.insetX : base.insetX,
    typeof rec.insetY === "number" && Number.isFinite(rec.insetY) ? rec.insetY : base.insetY,
    insetSize
  );
  return {
    kind: isLayoutKind(rec.kind) ? rec.kind : base.kind,
    main: isCameraSlot(rec.main) ? rec.main : base.main,
    insetSize,
    insetX: pos.x,
    insetY: pos.y,
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadCameraLayout(storage: StorageLike | null | undefined): CameraLayout {
  if (!storage) return defaultCameraLayout();
  try {
    const raw = storage.getItem(CAMERA_LAYOUT_SETTINGS_KEY);
    if (!raw) return defaultCameraLayout();
    return parseCameraLayout(JSON.parse(raw) as unknown);
  } catch {
    return defaultCameraLayout();
  }
}

export function persistCameraLayout(
  layout: CameraLayout,
  storage: StorageLike | null | undefined
): void {
  if (!storage) return;
  try {
    storage.setItem(CAMERA_LAYOUT_SETTINGS_KEY, JSON.stringify(layout));
  } catch {
    // quota / private mode — layout still lives in memory this session
  }
}

export function twoCamerasConfigured(config: ShowConfig): boolean {
  return (
    config.camera !== null &&
    config.captureCard !== null &&
    config.camera.deviceId !== config.captureCard.deviceId
  );
}

export function bothSourceNames(config: ShowConfig): { webcam: string; table: string } | null {
  if (!twoCamerasConfigured(config)) return null;
  return {
    webcam: config.camera?.label ?? "Camera",
    table: config.captureCard?.label ?? "Table",
  };
}

function rectToTransform(x: number, y: number, w: number, h: number): LayoutTransform {
  const t = computeCropToFill(ASSUMED_SOURCE_WIDTH, ASSUMED_SOURCE_HEIGHT, w, h);
  return {
    positionX: x,
    positionY: y,
    scaleX: t.scaleX,
    scaleY: t.scaleY,
    cropLeft: t.cropLeft,
    cropRight: t.cropRight,
    cropTop: t.cropTop,
    cropBottom: t.cropBottom,
  };
}

export function cameraRects(layout: CameraLayout): { webcam: CameraRect; table: CameraRect } {
  if (layout.kind === "split") {
    const half = CANVAS_HEIGHT / 2;
    const top: CameraRect = { x: 0, y: 0, w: CANVAS_WIDTH, h: half };
    const bottom: CameraRect = { x: 0, y: half, w: CANVAS_WIDTH, h: half };
    if (layout.main === "table") return { table: top, webcam: bottom };
    return { webcam: top, table: bottom };
  }
  const { w, h } = insetSizePx(layout.insetSize);
  const inset: CameraRect = { x: layout.insetX, y: layout.insetY, w, h };
  const full: CameraRect = { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
  if (layout.main === "table") return { table: full, webcam: inset };
  return { webcam: full, table: inset };
}

export function bothCameraTransforms(layout: CameraLayout): {
  webcam: LayoutTransform;
  table: LayoutTransform;
} {
  const rects = cameraRects(layout);
  return {
    webcam: rectToTransform(rects.webcam.x, rects.webcam.y, rects.webcam.w, rects.webcam.h),
    table: rectToTransform(rects.table.x, rects.table.y, rects.table.w, rects.table.h),
  };
}

export function insetSlot(layout: CameraLayout): CameraSlot {
  return layout.main === "table" ? "webcam" : "table";
}

export function displayedRect(t: LayoutTransform): CameraRect {
  const remainingW = ASSUMED_SOURCE_WIDTH - t.cropLeft - t.cropRight;
  const remainingH = ASSUMED_SOURCE_HEIGHT - t.cropTop - t.cropBottom;
  return {
    x: t.positionX,
    y: t.positionY,
    w: remainingW * t.scaleX,
    h: remainingH * t.scaleY,
  };
}

export function transformInsideCanvas(t: LayoutTransform, eps = 0.5): boolean {
  const r = displayedRect(t);
  return (
    r.x >= -eps &&
    r.y >= -eps &&
    r.x + r.w <= CANVAS_WIDTH + eps &&
    r.y + r.h <= CANVAS_HEIGHT + eps
  );
}

export const CAMERA_LAYOUT_COPY = {
  title: "Both cameras",
  inset: "Inset",
  split: "Split",
  small: "Small",
  medium: "Medium",
  large: "Large",
  swap: "Swap which is big",
  swapSplit: "Swap top / bottom",
  missing: "Need a webcam and a table camera for this. Pick a capture card on Setup.",
  disconnected: "Studio is not connected. Layout is saved and will apply when it is.",
  size: "Inset size",
  layout: "Layout",
} as const;

export interface CameraLayoutClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: CameraLayoutClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface CameraLayoutObsSyncOpts {
  getClient: () => ObsClient | null;
  isConnected?: () => boolean;
  getSourceNames: () => { webcam: string; table: string } | null;
  debounceMs?: number;
  clock?: CameraLayoutClock;
  storage?: StorageLike | null;
}

/**
 * Pushes BOTH-scene camera transforms. MOVE_INSET is debounced (one write
 * per gesture, not per pixel); swap / size / named layout / end-drag flush
 * immediately. Every OBS call is swallowed on failure.
 */
export class CameraLayoutObsSync {
  private readonly debounceMs: number;
  private readonly clock: CameraLayoutClock;
  private timer: unknown = null;
  private pending: CameraLayout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private idCache = new Map<string, number>();

  constructor(private readonly opts: CameraLayoutObsSyncOpts) {
    this.debounceMs = opts.debounceMs ?? CAMERA_LAYOUT_OBS_DEBOUNCE_MS;
    this.clock = opts.clock ?? realClock;
  }

  idle(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    this.clearTimer();
    this.pending = null;
    this.idCache.clear();
  }

  notify(action: CameraLayoutAction, next: CameraLayout): void {
    persistCameraLayout(next, this.opts.storage);
    if (action.type === "MOVE_INSET") {
      this.pending = next;
      this.schedule();
      return;
    }
    this.pending = next;
    this.flushNow();
  }

  resync(layout: CameraLayout): void {
    persistCameraLayout(layout, this.opts.storage);
    this.pending = layout;
    this.flushNow();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, this.debounceMs);
  }

  private flushNow(): void {
    this.clearTimer();
    const layout = this.pending;
    this.enqueue(async () => {
      if (layout === null) return;
      await this.apply(layout);
    });
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

  private readyClient(): ObsClient | null {
    const client = this.opts.getClient();
    if (!client) return null;
    if (this.opts.isConnected && !this.opts.isConnected()) return null;
    return client;
  }

  private async apply(layout: CameraLayout): Promise<void> {
    const names = this.opts.getSourceNames();
    const client = this.readyClient();
    if (!names || !client) return;
    const transforms = bothCameraTransforms(layout);
    try {
      const tableId = await this.resolveItemId(client, names.table);
      const webcamId = await this.resolveItemId(client, names.webcam);
      await client.call("SetSceneItemTransform", {
        sceneName: "BOTH",
        sceneItemId: tableId,
        sceneItemTransform: transforms.table,
      });
      await client.call("SetSceneItemTransform", {
        sceneName: "BOTH",
        sceneItemId: webcamId,
        sceneItemTransform: transforms.webcam,
      });
      if (layout.kind === "inset") {
        const mainId = layout.main === "table" ? tableId : webcamId;
        const insetId = layout.main === "table" ? webcamId : tableId;
        try {
          await client.call("SetSceneItemIndex", {
            sceneName: "BOTH",
            sceneItemId: mainId,
            sceneItemIndex: 0,
          });
          await client.call("SetSceneItemIndex", {
            sceneName: "BOTH",
            sceneItemId: insetId,
            sceneItemIndex: 1,
          });
        } catch {
          // index is best-effort; transforms still landed
        }
      }
    } catch {
      // disconnected or source missing — UI must not throw
    }
  }

  private async resolveItemId(client: ObsClient, sourceName: string): Promise<number> {
    const cached = this.idCache.get(sourceName);
    if (cached !== undefined) return cached;
    const res = await client.call<{ sceneItemId: number }>("GetSceneItemId", {
      sceneName: "BOTH",
      sourceName,
    });
    this.idCache.set(sourceName, res.sceneItemId);
    return res.sceneItemId;
  }
}
