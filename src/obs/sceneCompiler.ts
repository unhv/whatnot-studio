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
  | { type: "CreateInput"; inputName: string; inputKind: string; inputSettings?: Record<string, unknown> }
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

const BREAK_CARD_SOURCE = "BREAK Card";
const BREAK_CARD_KIND = "text_gdiplus_v3";

/** Build the desired four-scene model from a ShowConfig. Pure — no OBS. */
export function buildDesiredScenes(config: ShowConfig): DesiredScene[] {
  const cameraName = config.camera?.label ?? "Camera";
  const tableName = config.captureCard?.label ?? cameraName;

  const full = fullCanvasFillTransform();

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
    ],
  };

  // BOTH: table fills the canvas as background, me sits in a small inset
  // bottom-right, padded 24px off both edges.
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
    ],
  };

  const breakScene: DesiredScene = {
    sceneName: "BREAK",
    items: [
      {
        sourceName: BREAK_CARD_SOURCE,
        sourceKind: BREAK_CARD_KIND,
        inputSettings: { text: "BE RIGHT BACK" },
        transform: {
          positionX: 0,
          positionY: 0,
          scaleX: 1,
          scaleY: 1,
          cropLeft: 0,
          cropRight: 0,
          cropTop: 0,
          cropBottom: 0,
        },
        enabled: true,
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
      if (!existingInput && !inputsCreatedThisPass.has(item.sourceName)) {
        ops.push({
          type: "CreateInput",
          inputName: item.sourceName,
          inputKind: item.sourceKind,
          inputSettings: item.inputSettings,
        });
        inputsCreatedThisPass.add(item.sourceName);
      }

      const existingItem = findItem(currentScene, item.sourceName);
      if (!existingItem) {
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
      case "CreateInput":
        if (!inputs.find((i) => i.name === op.inputName)) {
          inputs.push({ name: op.inputName, kind: op.inputKind });
        }
        break;
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
