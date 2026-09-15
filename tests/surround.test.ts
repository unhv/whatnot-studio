import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyOpsToState,
  buildDesiredScenes,
  CAMERA_FACING_SCENES,
  CLIP_OVERLAY_SOURCE,
  compileScenePlan,
  EMPTY_OBS_STATE,
  fullCanvasFillTransform,
  ITEM_BAR_SOURCE,
  keepSurroundAndCameraOps,
  type ObsOp,
} from "../src/obs/sceneCompiler.js";
import {
  cameraLayoutReducer,
  DEFAULT_CAMERA_LAYOUT,
  loadCameraLayout,
  persistCameraLayout,
  transformForRect,
} from "../src/state/cameraLayout.js";
import {
  EMPTY_SHOW_STORE,
  parseShowStore,
  showByName,
  showStoreToJson,
  upsertShow,
} from "../src/state/showStore.js";
import {
  isSurroundSourceName,
  loadSurroundResolveOpts,
  NONE_SURROUND,
  NONE_SURROUND_ID,
  parseSurroundId,
  pickerEntries,
  resolveSurround,
  SURROUND_COPY,
  SURROUND_DEFS,
  SURROUND_KIND_IDS,
  surroundAssetPath,
  surroundFillTransform,
  surroundSourceName,
} from "../src/state/surround.js";
import { DEFAULT_SHOW_CONFIG, persistableShowConfig } from "../src/state/store.js";
import type { ShowConfig } from "../src/shared/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(root, "assets", "surrounds");

const config: ShowConfig = {
  showName: "Test Show",
  camera: { deviceId: "cam-1", label: "Webcam" },
  mic: { deviceId: "mic-1", label: "Microphone" },
  captureCard: { deviceId: "cap-1", label: "Capture Card" },
  obsPassword: "pw",
  obsPort: 4455,
};

function layoutWith(surroundId: string) {
  return cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, {
    type: "SET_SURROUND",
    surroundId: parseSurroundId(surroundId),
  });
}

function desiredFor(surroundId: string, exists: (p: string) => boolean = () => true) {
  return buildDesiredScenes(config, undefined, layoutWith(surroundId), { exists, assetsDir });
}

const FORBIDDEN_OBS = ["SetVideoSettings", "SetProfileParameter", "StartStream", "StopStream"];
const FORBIDDEN_SELLER = /\b(bitrate|kbps|resolution|codec|h264|vp9|ffmpeg)\b/i;

describe("surround list and copy", () => {
  it("treats none as a real default member of the named list", () => {
    expect(parseSurroundId(undefined)).toBe(NONE_SURROUND_ID);
    expect(parseSurroundId("nope")).toBe(NONE_SURROUND_ID);
    expect(DEFAULT_CAMERA_LAYOUT.surroundId).toBe(NONE_SURROUND_ID);
    const labels = pickerEntries().map((e) => e.label);
    expect(labels[0]).toBe(SURROUND_COPY.none);
    expect(labels).toHaveLength(4);
    expect(SURROUND_KIND_IDS).toHaveLength(3);
    const blob = `${SURROUND_COPY.title}${SURROUND_COPY.none}${SURROUND_COPY.missing}${SURROUND_DEFS.map((d) => d.label).join("")}`;
    expect(blob).not.toMatch(FORBIDDEN_SELLER);
  });

  it("gives each surround its own camera window inside the canvas", () => {
    const rects = SURROUND_DEFS.map((d) => JSON.stringify(d.cameraRect));
    expect(new Set(rects).size).toBe(SURROUND_DEFS.length);
    for (const def of SURROUND_DEFS) {
      expect(def.cameraRect.x).toBeGreaterThan(0);
      expect(def.cameraRect.y).toBeGreaterThan(0);
      expect(def.cameraRect.x + def.cameraRect.w).toBeLessThan(1080);
      expect(def.cameraRect.y + def.cameraRect.h).toBeLessThan(1920);
    }
    expect(NONE_SURROUND.cameraRect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });
});

describe("surround compiler ops", () => {
  it("none matches today's unframed camera layout and creates no surround input", () => {
    const none = desiredFor("none");
    const stock = buildDesiredScenes(config);
    expect(none).toEqual(stock);
    const me = none.find((s) => s.sceneName === "ME")!;
    expect(me.items[0].sourceName).toBe("Webcam");
    expect(me.items[0].transform).toEqual(fullCanvasFillTransform());
    expect(me.items[0].transform).toEqual(transformForRect(NONE_SURROUND.cameraRect));
    const ops = compileScenePlan(none, EMPTY_OBS_STATE);
    expect(ops.filter((o) => o.type === "CreateInput" && isSurroundSourceName(o.inputName))).toEqual([]);
    expect(ops.some((o) => o.type === "RemoveInput" || o.type === "RemoveSceneItem")).toBe(false);
  });

  it("selecting a surround puts an opaque loop under the camera and frames the camera", () => {
    const id = "warm-glow";
    const desired = desiredFor(id);
    const source = surroundSourceName(id);
    const resolved = resolveSurround(id, { exists: () => true, assetsDir });
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = desired.find((s) => s.sceneName === sceneName)!;
      expect(scene.items[0].sourceName).toBe(source);
      expect(scene.items[0].sourceKind).toBe("ffmpeg_source");
      expect(scene.items[0].enabled).toBe(true);
      expect(scene.items[0].transform).toEqual(surroundFillTransform());
      expect(scene.items[0].inputSettings?.local_file).toBe(surroundAssetPath(id, assetsDir));
      expect(scene.items[0].inputSettings?.looping).toBe(true);
      const camera = scene.items.find((i) => i.sourceName === "Webcam" || i.sourceName === "Capture Card")!;
      expect(camera.transform).not.toEqual(fullCanvasFillTransform());
      if (sceneName !== "BOTH") {
        expect(camera.transform).toEqual(transformForRect(resolved.cameraRect));
      }
    }
    const brk = desired.find((s) => s.sceneName === "BREAK")!;
    expect(brk.items.some((i) => isSurroundSourceName(i.sourceName))).toBe(false);
    expect(desired.find((s) => s.sceneName === "ME")!.items.some((i) => i.sourceName === CLIP_OVERLAY_SOURCE)).toBe(
      true
    );
  });

  it("CreateInput for a surround lands in ME once and does not duplicate the scene item", () => {
    const desired = desiredFor("cool-dusk");
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);
    const source = surroundSourceName("cool-dusk");
    const creates = ops.filter((o) => o.type === "CreateInput" && o.inputName === source);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ type: "CreateInput", sceneName: "ME", inputKind: "ffmpeg_source" });
    expect(
      ops.find((o) => o.type === "CreateSceneItem" && o.sceneName === "ME" && o.sourceName === source)
    ).toBeUndefined();
    expect(
      ops.find((o) => o.type === "CreateSceneItem" && o.sceneName === "TABLE" && o.sourceName === source)
    ).toBeDefined();
    expect(
      ops.find((o) => o.type === "CreateSceneItem" && o.sceneName === "BOTH" && o.sourceName === source)
    ).toBeDefined();
    const after = applyOpsToState(EMPTY_OBS_STATE, ops);
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = after.scenes.find((s) => s.name === sceneName)!;
      expect(scene.items.filter((i) => i.sourceName === source)).toHaveLength(1);
      expect(scene.items[0].sourceName).toBe(source);
    }
    expect(compileScenePlan(desired, after)).toEqual([]);
  });

  it("selecting none after a surround restores the unframed layout and leaves no orphan input", () => {
    const framed = desiredFor("soft-gold");
    const framedState = applyOpsToState(EMPTY_OBS_STATE, compileScenePlan(framed, EMPTY_OBS_STATE));
    expect(framedState.inputs.some((i) => isSurroundSourceName(i.name))).toBe(true);

    const none = desiredFor("none");
    const ops = compileScenePlan(none, framedState);
    expect(ops.filter((o) => o.type === "CreateInput")).toEqual([]);
    const source = surroundSourceName("soft-gold");
    expect(ops.filter((o) => o.type === "RemoveInput" && o.inputName === source)).toHaveLength(1);
    for (const sceneName of CAMERA_FACING_SCENES) {
      expect(
        ops.find((o) => o.type === "RemoveSceneItem" && o.sceneName === sceneName && o.sourceName === source)
      ).toBeDefined();
    }
    expect(ops).toEqual(
      expect.arrayContaining([
        {
          type: "SetSceneItemTransform",
          sceneName: "ME",
          sourceName: "Webcam",
          transform: fullCanvasFillTransform(),
        },
        {
          type: "SetSceneItemTransform",
          sceneName: "TABLE",
          sourceName: "Capture Card",
          transform: fullCanvasFillTransform(),
        },
      ])
    );

    const restored = applyOpsToState(framedState, ops);
    expect(restored.inputs.filter((i) => isSurroundSourceName(i.name))).toEqual([]);
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = restored.scenes.find((s) => s.name === sceneName)!;
      expect(scene.items.filter((i) => isSurroundSourceName(i.sourceName))).toEqual([]);
    }
    expect(compileScenePlan(none, restored)).toEqual([]);

    const stockState = applyOpsToState(EMPTY_OBS_STATE, compileScenePlan(buildDesiredScenes(config), EMPTY_OBS_STATE));
    expect(restored.inputs.map((i) => i.name).sort()).toEqual(stockState.inputs.map((i) => i.name).sort());
  });

  it("switching surrounds twice does not accumulate duplicate CreateInput scene items", () => {
    const order = ["warm-glow", "cool-dusk", "warm-glow", "soft-gold", "cool-dusk"] as const;
    let state = EMPTY_OBS_STATE;
    for (const id of order) {
      const desired = desiredFor(id);
      const ops = compileScenePlan(desired, state);
      const creates = ops.filter(
        (o): o is Extract<ObsOp, { type: "CreateInput" }> =>
          o.type === "CreateInput" && isSurroundSourceName(o.inputName)
      );
      expect(creates.length).toBeLessThanOrEqual(1);
      if (creates[0]) {
        expect(creates[0]).toMatchObject({ sceneName: "ME" });
        const createdName = creates[0].inputName;
        expect(
          ops.find(
            (o) => o.type === "CreateSceneItem" && o.sceneName === "ME" && o.sourceName === createdName
          )
        ).toBeUndefined();
      }
      state = applyOpsToState(state, ops);
      const wanted = surroundSourceName(id);
      expect(state.inputs.filter((i) => isSurroundSourceName(i.name)).map((i) => i.name)).toEqual([wanted]);
      for (const sceneName of CAMERA_FACING_SCENES) {
        const scene = state.scenes.find((s) => s.name === sceneName)!;
        const surroundItems = scene.items.filter((i) => isSurroundSourceName(i.sourceName));
        expect(surroundItems).toHaveLength(1);
        expect(surroundItems[0].sourceName).toBe(wanted);
        expect(scene.items.filter((i) => i.sourceName === wanted)).toHaveLength(1);
      }
      expect(compileScenePlan(desired, state)).toEqual([]);
    }
  });

  it("a missing surround file degrades to none with a seller message and never throws", () => {
    expect(() => desiredFor("warm-glow", () => false)).not.toThrow();
    const missing = desiredFor("warm-glow", () => false);
    const none = desiredFor("none");
    expect(missing).toEqual(none);
    const resolved = resolveSurround("warm-glow", { exists: () => false, assetsDir });
    expect(resolved.id).toBe(NONE_SURROUND_ID);
    expect(resolved.sourceName).toBeNull();
    expect(resolved.message).toBe(SURROUND_COPY.missing);
    expect(resolved.message).not.toMatch(FORBIDDEN_SELLER);
    const throwing = () => {
      throw new Error("disk exploded");
    };
    expect(() => resolveSurround("cool-dusk", { exists: throwing, assetsDir })).not.toThrow();
    expect(resolveSurround("cool-dusk", { exists: throwing, assetsDir }).id).toBe(NONE_SURROUND_ID);
    const ops = compileScenePlan(missing, EMPTY_OBS_STATE);
    expect(ops.filter((o) => o.type === "CreateInput" && isSurroundSourceName(o.inputName))).toEqual([]);
    const me = applyOpsToState(EMPTY_OBS_STATE, ops).scenes.find((s) => s.name === "ME")!;
    expect(me.items.find((i) => i.sourceName === "Webcam")).toBeTruthy();
    expect(me.items[0].sourceName).toBe("Webcam");
  });

  it("picker keep-filter drops overlay ops and keeps surround plus cameras", () => {
    const desired = desiredFor("warm-glow");
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);
    const kept = ops.filter(keepSurroundAndCameraOps(["Webcam", "Capture Card"]));
    expect(kept.some((o) => o.type === "CreateInput" && isSurroundSourceName(o.inputName))).toBe(true);
    expect(
      kept.filter((o) => {
        const name =
          o.type === "CreateInput" || o.type === "RemoveInput"
            ? o.inputName
            : o.type === "CreateScene"
              ? ""
              : o.sourceName;
        return name === ITEM_BAR_SOURCE || name === CLIP_OVERLAY_SOURCE;
      })
    ).toEqual([]);
    expect(kept.some((o) => o.type === "CreateScene")).toBe(false);
  });
});

describe("surround persistence", () => {
  it("round-trips the chosen surround through camera layout and the saved show", () => {
    const mem = {
      data: new Map<string, string>(),
      getItem(key: string) {
        return this.data.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.data.set(key, value);
      },
    };
    const picked = layoutWith("cool-dusk");
    persistCameraLayout(picked, mem);
    expect(loadCameraLayout(mem).surroundId).toBe("cool-dusk");

    const cfg = persistableShowConfig({
      ...DEFAULT_SHOW_CONFIG,
      showName: "Saturday Night Vintage",
      camera: { deviceId: "cam-sat", label: "Elgato Facecam" },
    });
    const stored = upsertShow(EMPTY_SHOW_STORE, cfg, { cameraLayout: loadCameraLayout(mem) });
    const json = showStoreToJson(stored);
    const loaded = parseShowStore(json);
    const found = showByName(loaded, "Saturday Night Vintage");
    expect(found).toBeTruthy();
    expect((found!.cameraLayout as { surroundId: string }).surroundId).toBe("cool-dusk");
  });
});

describe("surround path resolution", () => {
  it("degrades to none when main reports the file missing", async () => {
    const g = globalThis as {
      whatnotStudio?: {
        surroundsDir: () => Promise<string>;
        clipsExists: (filePath: string) => Promise<boolean>;
      };
    };
    const prev = g.whatnotStudio;
    g.whatnotStudio = {
      surroundsDir: async () => assetsDir,
      clipsExists: async () => false,
    };
    try {
      const opts = await loadSurroundResolveOpts("warm-glow");
      const resolved = resolveSurround("warm-glow", opts);
      expect(resolved.id).toBe(NONE_SURROUND_ID);
      expect(resolved.message).toBe(SURROUND_COPY.missing);
    } finally {
      g.whatnotStudio = prev;
    }
  });
});

describe("surround assets and generator", () => {
  it("commits the three generated loops and a filter-only script", () => {
    const scriptPath = path.join(root, "scripts", "make-surrounds.mjs");
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf8");
    expect(script).not.toMatch(/drawtext/i);
    expect(script).toMatch(/ffmpeg/);
    for (const id of SURROUND_KIND_IDS) {
      const file = path.join(assetsDir, `${id}.mp4`);
      expect(existsSync(file)).toBe(true);
    }
  });
});

describe("surround never drives stream or canvas settings", () => {
  it("does not call SetVideoSettings, SetProfileParameter, StartStream or StopStream", () => {
    const files = [
      "src/state/surround.ts",
      "src/state/cameraLayout.ts",
      "src/obs/sceneCompiler.ts",
      "src/renderer/CameraLayoutPanel.tsx",
      "scripts/make-surrounds.mjs",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(root, rel), "utf8");
      for (const fn of FORBIDDEN_OBS) {
        expect(src).not.toContain(fn);
      }
    }
    const desired = desiredFor("warm-glow");
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);
    const types = ops.map((o) => o.type);
    for (const fn of FORBIDDEN_OBS) {
      expect(types).not.toContain(fn);
    }
  });
});
