/**
 * Pure scene compiler: turns a `ShowConfig` into a list of OBS requests
 * ("ops") that bring the current state into line with the desired
 * four-scene model. No network, no OBS — the actual applying of ops
 * (via ObsClient.call) happens in src/obs/applyPlan.ts, kept separate so
 * this file stays trivially unit-testable.
 *
 * Idempotence is the whole point: compilePlan(desired, current) is a pure
 * function of its inputs (deterministic — calling it twice on the same
 * inputs yields deep-equal output), and applying its ops to `current`
 * converges: compiling again against the post-apply state yields zero ops.
 */
import { computeCropToFill, type CropToFill } from "../../spike/lib.js";
import {
  ASSUMED_SOURCE_HEIGHT,
  ASSUMED_SOURCE_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type ShowConfig,
} from "../shared/types.js";

export interface Transform {
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
}

export interface DesiredSceneItem {
  sourceName: string;
  sourceKind: string;
  inputSettings?: Record<string, unknown>;
  transform: Transform;
  enabled: boolean;
}

export interface DesiredScene {
  sceneName: string;
  items: DesiredSceneItem[];
}

export interface CurrentSceneItem {
  sourceName: string;
  enabled: boolean;
  transform?: Partial<Transform>;
}

export interface CurrentScene {
  name: string;
  items: CurrentSceneItem[];
}

export interface CurrentInput {
  name: string;
  kind: string;
}

export interface CurrentObsState {
  scenes: CurrentScene[];
  inputs: CurrentInput[];
}

export const EMPTY_OBS_STATE: CurrentObsState = { scenes: [], inputs: [] };

export type ObsOp =
  // MEASURED 2026-09-15 (FINDINGS.md): OBS's own CreateInput adds the new
  // input as a scene item to `sceneName` as a side effect. `sceneName` here
  // must be the scene the input is *first* used in, not an arbitrary
  // default -- passing the wrong scene (e.g. always desired[0]'s scene)
  // was confirmed live to dump every new input's item into that one scene
  // regardless of which scene actually needed it.
  | {
      type: "CreateInput";
      inputName: string;
      inputKind: string;
      inputSettings?: Record<string, unknown>;
      sceneName: string;
    }
  | { type: "CreateScene"; sceneName: string }
  | { type: "CreateSceneItem"; sceneName: string; sourceName: string }
  | { type: "SetSceneItemTransform"; sceneName: string; sourceName: string; transform: Transform }
  | { type: "SetSceneItemEnabled"; sceneName: string; sourceName: string; enabled: boolean };

const TRANSFORM_EPS = 0.01;

function transformsEqual(a: Transform, b: Partial<Transform> | undefined): boolean {
  if (!b) return false;
  const keys: (keyof Transform)[] = [
    "positionX",
    "positionY",
    "scaleX",
    "scaleY",
    "cropLeft",
    "cropRight",
    "cropTop",
    "cropBottom",
  ];
  return keys.every((k) => {
    const bv = b[k];
    if (bv === undefined) return false;
    return Math.abs(a[k] - bv) <= TRANSFORM_EPS;
  });
}

function cropToTransform(c: CropToFill): Transform {
  return {
    positionX: c.positionX,
    positionY: c.positionY,
    scaleX: c.scaleX,
    scaleY: c.scaleY,
    cropLeft: c.cropLeft,
    cropRight: c.cropRight,
    cropTop: c.cropTop,
    cropBottom: c.cropBottom,
  };
}

/** Full-canvas crop-to-fill transform for a 16:9-assumed source. */
export function fullCanvasFillTransform(): Transform {
  return cropToTransform(
    computeCropToFill(ASSUMED_SOURCE_WIDTH, ASSUMED_SOURCE_HEIGHT, CANVAS_WIDTH, CANVAS_HEIGHT)
  );
}

/** Crop-to-fill a source into a small tile of `tileW`x`tileH`, positioned
 * with its top-left corner at (offsetX, offsetY) in canvas space — used for
 * the small "me" inset in the BOTH scene. */
export function tileFillTransform(tileW: number, tileH: number, offsetX: number, offsetY: number): Transform {
  const t = cropToTransform(computeCropToFill(ASSUMED_SOURCE_WIDTH, ASSUMED_SOURCE_HEIGHT, tileW, tileH));
  return { ...t, positionX: offsetX, positionY: offsetY };
}

export const BREAK_CARD_SOURCE = "BREAK Card";
const BREAK_CARD_KIND = "text_gdiplus_v3";
export const BREAK_CARD_TEXT = "BE RIGHT BACK";

/** Same input name in every camera-facing scene so one SetInputSettings updates all of them. */
export const ITEM_BAR_SOURCE = "Item Bar";
export const SOLD_BANNER_SOURCE = "SOLD Banner";
export const TEXT_SOURCE_KIND = "text_gdiplus_v3";
export const CAMERA_FACING_SCENES = ["ME", "TABLE", "BOTH"] as const;
export const SOLD_BANNER_TEXT = "SOLD!";

export const TEXT_OVERLAY_IDS = ["itemBar", "soldBanner", "breakCard"] as const;
export type TextOverlayId = (typeof TEXT_OVERLAY_IDS)[number];
export const TEXT_SIZE_NAMES = ["small", "normal", "huge"] as const;
export type TextSizeName = (typeof TEXT_SIZE_NAMES)[number];
export const TEXT_SNAP_NAMES = ["top", "middle", "bottom", "safe"] as const;
export type TextSnapName = (typeof TEXT_SNAP_NAMES)[number];

/**
 * Whatnot's own chrome on a 1080×1920 phone stream: header along the top,
 * bid/buy bar along the bottom. "safe" snap keeps the box clear of both.
 */
export const WHATNOT_SAFE_TOP = 220;
export const WHATNOT_SAFE_BOTTOM = 380;
/** Pad off the physical bottom edge for the "bottom" (lower-third) snap. */
export const BOTTOM_EDGE_PAD = 80;
export const SNAP_THRESHOLD_PX = 80;
export const PREVIEW_WIDTH = 270;
export const PREVIEW_HEIGHT = 480;

const SIZE_SCALE: Record<TextSizeName, number> = { small: 0.67, normal: 1, huge: 1.5 };

const OVERLAY_BASE = {
  itemBar: { font: 72, outline: 8, width: 1000, height: 320, backing: 70 },
  soldBanner: { font: 160, outline: 16, width: 1000, height: 400, backing: 80 },
  breakCard: { font: 120, outline: 12, width: 1000, height: 400, backing: 70 },
} as const;

export function overlaySourceName(id: TextOverlayId): string {
  switch (id) {
    case "itemBar":
      return ITEM_BAR_SOURCE;
    case "soldBanner":
      return SOLD_BANNER_SOURCE;
    case "breakCard":
      return BREAK_CARD_SOURCE;
  }
}

export function overlaySceneNames(id: TextOverlayId): readonly string[] {
  return id === "breakCard" ? ["BREAK"] : CAMERA_FACING_SCENES;
}

export function overlayFontSize(id: TextOverlayId, size: TextSizeName): number {
  return Math.round(OVERLAY_BASE[id].font * SIZE_SCALE[size]);
}

export function overlayBox(id: TextOverlayId, size: TextSizeName): { width: number; height: number } {
  const s = SIZE_SCALE[size];
  return {
    width: Math.min(CANVAS_WIDTH, Math.round(OVERLAY_BASE[id].width * s)),
    height: Math.round(OVERLAY_BASE[id].height * s),
  };
}

export function overlayOutlineSize(id: TextOverlayId, size: TextSizeName): number {
  return Math.max(4, Math.round(OVERLAY_BASE[id].outline * SIZE_SCALE[size]));
}

function identityLikeTransform(positionX: number, positionY: number): Transform {
  return {
    positionX,
    positionY,
    scaleX: 1,
    scaleY: 1,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
  };
}

export function snapPositionY(snap: TextSnapName, boxHeight: number): number {
  switch (snap) {
    case "top":
      return WHATNOT_SAFE_TOP;
    case "middle":
      return Math.round((CANVAS_HEIGHT - boxHeight) / 2);
    case "bottom":
      return CANVAS_HEIGHT - boxHeight - BOTTOM_EDGE_PAD;
    case "safe":
      return CANVAS_HEIGHT - WHATNOT_SAFE_BOTTOM - boxHeight;
  }
}

export function overlaySnapTransform(id: TextOverlayId, snap: TextSnapName, size: TextSizeName): Transform {
  const box = overlayBox(id, size);
  const x = Math.round((CANVAS_WIDTH - box.width) / 2);
  return identityLikeTransform(x, snapPositionY(snap, box.height));
}

export function overlayTransformAt(positionX: number, positionY: number): Transform {
  return identityLikeTransform(positionX, positionY);
}

export function clampOverlayPosition(
  id: TextOverlayId,
  size: TextSizeName,
  x: number,
  y: number
): { x: number; y: number } {
  const box = overlayBox(id, size);
  return {
    x: Math.round(Math.min(Math.max(x, 0), CANVAS_WIDTH - box.width)),
    y: Math.round(Math.min(Math.max(y, 0), CANVAS_HEIGHT - box.height)),
  };
}

export function nearestSnap(
  id: TextOverlayId,
  size: TextSizeName,
  x: number,
  y: number
): { snap: TextSnapName | "custom"; positionX: number; positionY: number } {
  let best: TextSnapName = "middle";
  let bestDist = Infinity;
  let bestT = overlaySnapTransform(id, "middle", size);
  for (const snap of TEXT_SNAP_NAMES) {
    const t = overlaySnapTransform(id, snap, size);
    const d = Math.hypot(t.positionX - x, t.positionY - y);
    if (d < bestDist) {
      bestDist = d;
      best = snap;
      bestT = t;
    }
  }
  if (bestDist <= SNAP_THRESHOLD_PX) {
    return { snap: best, positionX: bestT.positionX, positionY: bestT.positionY };
  }
  return { snap: "custom", positionX: x, positionY: y };
}

/**
 * text_gdiplus_v3 fill/outline/backing. Colors are Windows COLORREF (0x00BBGGRR).
 * Outline + backing stay black so a busy card mat cannot swallow the fill.
 */
export function overlayInputSettings(
  id: TextOverlayId,
  opts: { colorref: number; size: TextSizeName; text?: string }
): Record<string, unknown> {
  const box = overlayBox(id, opts.size);
  const settings: Record<string, unknown> = {
    font: { face: "Arial Black", size: overlayFontSize(id, opts.size), flags: 1, style: "Bold" },
    color: opts.colorref,
    outline: true,
    outline_size: overlayOutlineSize(id, opts.size),
    outline_color: 0x000000,
    bk_color: 0x000000,
    bk_opacity: OVERLAY_BASE[id].backing,
    align: "center",
    valign: "center",
    extents: true,
    extents_cx: box.width,
    extents_cy: box.height,
  };
  if (opts.text !== undefined) settings.text = opts.text;
  return settings;
}

/** Style-only patch for SetInputSettings — never includes `text`, so a colour
 * drag cannot clobber the item name the seller just typed. */
export function overlayStyleSettings(
  id: TextOverlayId,
  opts: { colorref: number; size: TextSizeName }
): Record<string, unknown> {
  const settings = overlayInputSettings(id, opts);
  delete settings.text;
  return settings;
}

export const ITEM_BAR_TEXT_SETTINGS: Record<string, unknown> = overlayInputSettings("itemBar", {
  colorref: 0xffffff,
  size: "normal",
  text: "",
});

export const SOLD_BANNER_TEXT_SETTINGS: Record<string, unknown> = overlayInputSettings("soldBanner", {
  colorref: 0x0028c8ff,
  size: "normal",
  text: SOLD_BANNER_TEXT,
});

export const BREAK_CARD_TEXT_SETTINGS: Record<string, unknown> = overlayInputSettings("breakCard", {
  colorref: 0xffffff,
  size: "normal",
  text: BREAK_CARD_TEXT,
});

export const ITEM_BAR_TRANSFORM: Transform = overlaySnapTransform("itemBar", "safe", "normal");
export const SOLD_BANNER_TRANSFORM: Transform = overlaySnapTransform("soldBanner", "middle", "normal");
export const BREAK_CARD_TRANSFORM: Transform = overlaySnapTransform("breakCard", "middle", "normal");

/** Preset fills. Gold matches the SOLD default. Ice/hot read on a card mat. */
export const TEXT_COLOR_PRESETS: { id: string; label: string; colorref: number }[] = [
  { id: "white", label: "White", colorref: 0xffffff },
  { id: "gold", label: "Gold", colorref: 0x0028c8ff },
  { id: "red", label: "Red", colorref: 0x000000ff },
  { id: "ice", label: "Ice", colorref: 0x00ffe7c2 },
  { id: "hot", label: "Hot", colorref: 0x004a22ff },
];

export function cssHexToColorref(hex: string): number {
  const raw = hex.replace("#", "").trim();
  const h =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 0xffffff;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

export function colorrefToCssHex(colorref: number): string {
  const r = colorref & 0xff;
  const g = (colorref >> 8) & 0xff;
  const b = (colorref >> 16) & 0xff;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function channelLuminance(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colorref: number): number {
  const r = colorref & 0xff;
  const g = (colorref >> 8) & 0xff;
  const b = (colorref >> 16) & 0xff;
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: number, b: number): number {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black outline + backing keep the fill readable; warn when the fill itself
 * is too close to that black to survive a busy card mat. */
export const UNREADABLE_CONTRAST = 3;

export function fillUnreadableOnMat(colorref: number): boolean {
  return contrastRatio(colorref, 0x000000) < UNREADABLE_CONTRAST;
}

export function canvasPointFromPreview(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number }
): { x: number; y: number } {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    x: ((clientX - rect.left) / w) * CANVAS_WIDTH,
    y: ((clientY - rect.top) / h) * CANVAS_HEIGHT,
  };
}

function identityTransform(): Transform {
  return {
    positionX: 0,
    positionY: 0,
    scaleX: 1,
    scaleY: 1,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
  };
}

/** Overlays created disabled so a fresh setup shows nothing until the seller puts something up. */
function cameraFacingOverlays(): DesiredSceneItem[] {
  return [
    {
      sourceName: ITEM_BAR_SOURCE,
      sourceKind: TEXT_SOURCE_KIND,
      inputSettings: ITEM_BAR_TEXT_SETTINGS,
      transform: ITEM_BAR_TRANSFORM,
      enabled: false,
    },
    {
      sourceName: SOLD_BANNER_SOURCE,
      sourceKind: TEXT_SOURCE_KIND,
      inputSettings: SOLD_BANNER_TEXT_SETTINGS,
      transform: SOLD_BANNER_TRANSFORM,
      enabled: false,
    },
  ];
}

/** Build the desired four-scene model from a ShowConfig. Pure — no OBS.
 * `overlayVisible.breakCard` is the seller's show/hide; omit it and BREAK
 * still comes up with BE RIGHT BACK on. Item bar / SOLD stay compiled
 * disabled — those flags belong to the SHOW/CLEAR/SOLD path. */
export function buildDesiredScenes(
  config: ShowConfig,
  overlayVisible?: Partial<Record<TextOverlayId, boolean>>
): DesiredScene[] {
  const cameraName = config.camera?.label ?? "Camera";
  const tableName = config.captureCard?.label ?? cameraName;

  const full = fullCanvasFillTransform();
  const overlays = cameraFacingOverlays();

  const meScene: DesiredScene = {
    sceneName: "ME",
    items: [
      {
        sourceName: cameraName,
        sourceKind: "dshow_input",
        inputSettings: config.camera ? { video_device_id: config.camera.deviceId } : undefined,
        transform: full,
        enabled: true,
      },
      ...overlays,
    ],
  };

  const tableScene: DesiredScene = {
    sceneName: "TABLE",
    items: [
      {
        sourceName: tableName,
        sourceKind: "dshow_input",
        inputSettings: config.captureCard
          ? { video_device_id: config.captureCard.deviceId }
          : config.camera
            ? { video_device_id: config.camera.deviceId }
            : undefined,
        transform: full,
        enabled: true,
      },
      ...overlays,
    ],
  };

  // BOTH: table fills the canvas as background, me sits in a small inset
  // bottom-right, padded 24px off both edges. Overlays sit on top.
  const insetW = Math.round(CANVAS_WIDTH * 0.32);
  const insetTileH = Math.round(insetW * (16 / 9)); // portrait inset tile, matches canvas orientation
  const pad = 24;
  const bothScene: DesiredScene = {
    sceneName: "BOTH",
    items: [
      {
        sourceName: tableName,
        sourceKind: "dshow_input",
        transform: full,
        enabled: true,
      },
      {
        sourceName: cameraName,
        sourceKind: "dshow_input",
        transform: tileFillTransform(
          insetW,
          insetTileH,
          CANVAS_WIDTH - insetW - pad,
          CANVAS_HEIGHT - insetTileH - pad
        ),
        enabled: true,
      },
      ...overlays,
    ],
  };

  const breakScene: DesiredScene = {
    sceneName: "BREAK",
    items: [
      {
        sourceName: BREAK_CARD_SOURCE,
        sourceKind: BREAK_CARD_KIND,
        inputSettings: BREAK_CARD_TEXT_SETTINGS,
        transform: BREAK_CARD_TRANSFORM,
        enabled: overlayVisible?.breakCard ?? true,
      },
    ],
  };

  return [meScene, tableScene, bothScene, breakScene];
}

function findScene(current: CurrentObsState, sceneName: string): CurrentScene | undefined {
  return current.scenes.find((s) => s.name === sceneName);
}

function findInput(current: CurrentObsState, name: string): CurrentInput | undefined {
  return current.inputs.find((i) => i.name === name);
}

function findItem(scene: CurrentScene | undefined, sourceName: string): CurrentSceneItem | undefined {
  return scene?.items.find((i) => i.sourceName === sourceName);
}

/**
 * Compile the ops needed to bring `current` into line with `desired`.
 * Deterministic and side-effect free: same inputs -> deep-equal output.
 */
export function compileScenePlan(desired: DesiredScene[], current: CurrentObsState): ObsOp[] {
  const ops: ObsOp[] = [];
  const inputsCreatedThisPass = new Set<string>();

  for (const scene of desired) {
    const currentScene = findScene(current, scene.sceneName);
    if (!currentScene) {
      ops.push({ type: "CreateScene", sceneName: scene.sceneName });
    }

    for (const item of scene.items) {
      const existingInput = findInput(current, item.sourceName);
      // Did *this* CreateInput op (if any is emitted below) already drop a
      // scene item into `scene.sceneName` as OBS's own side effect? If so,
      // the separate CreateSceneItem below must be skipped for this scene
      // or OBS ends up with two items for the same source.
      let createdIntoThisScene = false;
      if (!existingInput && !inputsCreatedThisPass.has(item.sourceName)) {
        ops.push({
          type: "CreateInput",
          inputName: item.sourceName,
          inputKind: item.sourceKind,
          inputSettings: item.inputSettings,
          sceneName: scene.sceneName,
        });
        inputsCreatedThisPass.add(item.sourceName);
        createdIntoThisScene = true;
      }

      const existingItem = findItem(currentScene, item.sourceName);
      if (!existingItem && !createdIntoThisScene) {
        ops.push({ type: "CreateSceneItem", sceneName: scene.sceneName, sourceName: item.sourceName });
      }

      if (!existingItem || !transformsEqual(item.transform, existingItem.transform)) {
        ops.push({
          type: "SetSceneItemTransform",
          sceneName: scene.sceneName,
          sourceName: item.sourceName,
          transform: item.transform,
        });
      }

      if (!existingItem || existingItem.enabled !== item.enabled) {
        ops.push({
          type: "SetSceneItemEnabled",
          sceneName: scene.sceneName,
          sourceName: item.sourceName,
          enabled: item.enabled,
        });
      }
    }
  }

  return ops;
}

/** Simulate applying `ops` to `current`, used by tests to prove convergence
 * (compiling again against the result yields zero ops). Not used at runtime
 * — the real apply path re-reads OBS's actual state instead of trusting a
 * simulation, since OBS is the source of truth. */
export function applyOpsToState(current: CurrentObsState, ops: ObsOp[]): CurrentObsState {
  const scenes = current.scenes.map((s) => ({ name: s.name, items: s.items.map((i) => ({ ...i })) }));
  const inputs = current.inputs.map((i) => ({ ...i }));

  const getOrCreateScene = (name: string): CurrentScene => {
    let scene = scenes.find((s) => s.name === name);
    if (!scene) {
      scene = { name, items: [] };
      scenes.push(scene);
    }
    return scene;
  };

  for (const op of ops) {
    switch (op.type) {
      case "CreateInput": {
        if (!inputs.find((i) => i.name === op.inputName)) {
          inputs.push({ name: op.inputName, kind: op.inputKind });
        }
        // Mirrors OBS's own measured side effect: CreateInput also drops a
        // scene item into its target scene.
        const targetScene = getOrCreateScene(op.sceneName);
        if (!targetScene.items.find((i) => i.sourceName === op.inputName)) {
          targetScene.items.push({ sourceName: op.inputName, enabled: true });
        }
        break;
      }
      case "CreateScene":
        getOrCreateScene(op.sceneName);
        break;
      case "CreateSceneItem": {
        const scene = getOrCreateScene(op.sceneName);
        if (!scene.items.find((i) => i.sourceName === op.sourceName)) {
          scene.items.push({ sourceName: op.sourceName, enabled: true });
        }
        break;
      }
      case "SetSceneItemTransform": {
        const scene = getOrCreateScene(op.sceneName);
        const item = scene.items.find((i) => i.sourceName === op.sourceName);
        if (item) item.transform = { ...op.transform };
        break;
      }
      case "SetSceneItemEnabled": {
        const scene = getOrCreateScene(op.sceneName);
        const item = scene.items.find((i) => i.sourceName === op.sourceName);
        if (item) item.enabled = op.enabled;
        break;
      }
    }
  }

  return { scenes, inputs };
}
