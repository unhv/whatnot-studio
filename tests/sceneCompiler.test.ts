import { describe, it, expect } from "vitest";
import {
  applyOpsToState,
  BREAK_CARD_SOURCE,
  BREAK_CARD_TEXT_SETTINGS,
  BREAK_CARD_TRANSFORM,
  buildDesiredScenes,
  CAMERA_FACING_SCENES,
  compileScenePlan,
  contrastRatio,
  cssHexToColorref,
  EMPTY_OBS_STATE,
  fillUnreadableOnMat,
  fullCanvasFillTransform,
  ITEM_BAR_SOURCE,
  ITEM_BAR_TEXT_SETTINGS,
  ITEM_BAR_TRANSFORM,
  nearestSnap,
  overlayBox,
  overlayInputSettings,
  overlaySnapTransform,
  overlaySourceName,
  overlayStyleSettings,
  SOLD_BANNER_SOURCE,
  SOLD_BANNER_TEXT,
  SOLD_BANNER_TEXT_SETTINGS,
  SOLD_BANNER_TRANSFORM,
  TEXT_SNAP_NAMES,
  TEXT_SOURCE_KIND,
  WHATNOT_SAFE_BOTTOM,
  WHATNOT_SAFE_TOP,
} from "../src/obs/sceneCompiler.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, type ShowConfig } from "../src/shared/types.js";
import {
  bothCameraTransforms,
  cameraLayoutReducer,
  DEFAULT_CAMERA_LAYOUT,
  transformInsideCanvas,
} from "../src/state/cameraLayout.js";

const config: ShowConfig = {
  showName: "Test Show",
  camera: { deviceId: "cam-1", label: "Webcam" },
  mic: { deviceId: "mic-1", label: "Microphone" },
  captureCard: { deviceId: "cap-1", label: "Capture Card" },
  obsPassword: "pw",
  obsPort: 4455,
};

describe("compileScenePlan", () => {
  it("is deterministic: same inputs produce identical (deep-equal) ops", () => {
    const desired = buildDesiredScenes(config);
    const opsA = compileScenePlan(desired, EMPTY_OBS_STATE);
    const opsB = compileScenePlan(desired, EMPTY_OBS_STATE);
    expect(opsB).toEqual(opsA);
  });

  it("creates all four scenes and their sources from an empty OBS state", () => {
    const desired = buildDesiredScenes(config);
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);

    const sceneNames = ops.filter((o) => o.type === "CreateScene").map((o) => o.sceneName);
    expect(sceneNames.sort()).toEqual(["BOTH", "BREAK", "ME", "TABLE"].sort());

    // camera input created once even though it's used in ME and BOTH
    const webcamCreates = ops.filter((o) => o.type === "CreateInput" && o.inputName === "Webcam");
    expect(webcamCreates.length).toBe(1);
  });

  it("converges: applying ops then recompiling against the result yields zero ops", () => {
    const desired = buildDesiredScenes(config);
    const firstOps = compileScenePlan(desired, EMPTY_OBS_STATE);
    const afterState = applyOpsToState(EMPTY_OBS_STATE, firstOps);
    const secondOps = compileScenePlan(desired, afterState);
    expect(secondOps).toEqual([]);
  });

  it("running the compile twice against a fully-converged state never duplicates scenes/items", () => {
    const desired = buildDesiredScenes(config);
    const firstOps = compileScenePlan(desired, EMPTY_OBS_STATE);
    const stateAfterFirst = applyOpsToState(EMPTY_OBS_STATE, firstOps);

    // simulate "running the compile twice": compile+apply again from the converged state
    const secondOps = compileScenePlan(desired, stateAfterFirst);
    const stateAfterSecond = applyOpsToState(stateAfterFirst, secondOps);

    expect(stateAfterSecond.scenes.length).toBe(stateAfterFirst.scenes.length);
    for (const scene of stateAfterFirst.scenes) {
      const matching = stateAfterSecond.scenes.find((s) => s.name === scene.name);
      expect(matching?.items.length).toBe(scene.items.length);
    }
  });

  it(
    "CreateInput targets the scene the input is first used in, and never emits a " +
      "duplicate CreateSceneItem for that same scene",
    () => {
      // MEASURED 2026-09-15 (FINDINGS.md): OBS's real CreateInput adds the new
      // input as a scene item to whatever sceneName is passed, as a side
      // effect. Confirmed live: passing the wrong scene there (or always the
      // same default scene) left every new input's first item in the wrong
      // scene, and a duplicate copy in the scene it should have been in.
      const desired = buildDesiredScenes(config);
      const ops = compileScenePlan(desired, EMPTY_OBS_STATE);

      const webcamCreate = ops.find((o) => o.type === "CreateInput" && o.inputName === "Webcam");
      expect(webcamCreate).toMatchObject({ type: "CreateInput", sceneName: "ME" });

      // ME is Webcam's first scene -- CreateInput already puts the item there,
      // so no separate CreateSceneItem should be emitted for ME/Webcam.
      const meWebcamCreateSceneItem = ops.find(
        (o) => o.type === "CreateSceneItem" && o.sceneName === "ME" && o.sourceName === "Webcam"
      );
      expect(meWebcamCreateSceneItem).toBeUndefined();

      // BOTH also uses Webcam (as the inset) -- that scene genuinely needs its
      // own CreateSceneItem, since CreateInput's side effect only landed one
      // item, in ME.
      const bothWebcamCreateSceneItem = ops.find(
        (o) => o.type === "CreateSceneItem" && o.sceneName === "BOTH" && o.sourceName === "Webcam"
      );
      expect(bothWebcamCreateSceneItem).toBeDefined();

      const afterState = applyOpsToState(EMPTY_OBS_STATE, ops);
      const meScene = afterState.scenes.find((s) => s.name === "ME")!;
      expect(meScene.items.filter((i) => i.sourceName === "Webcam").length).toBe(1);
    }
  );

  it("only touches the changed field when one item's transform drifts", () => {
    const desired = buildDesiredScenes(config);
    const firstOps = compileScenePlan(desired, EMPTY_OBS_STATE);
    const converged = applyOpsToState(EMPTY_OBS_STATE, firstOps);

    // simulate someone/something nudging the ME camera's position in OBS
    const drifted = {
      scenes: converged.scenes.map((s) =>
        s.name === "ME"
          ? {
              ...s,
              items: s.items.map((i) =>
                i.sourceName === "Webcam" && i.transform
                  ? {
                      ...i,
                      transform: {
                        ...i.transform,
                        positionX: (i.transform.positionX ?? 0) + 50,
                      },
                    }
                  : i
              ),
            }
          : s
      ),
      inputs: converged.inputs,
    };

    const ops = compileScenePlan(desired, drifted);
    expect(ops).toEqual([
      {
        type: "SetSceneItemTransform",
        sceneName: "ME",
        sourceName: "Webcam",
        transform: fullCanvasFillTransform(),
      },
    ]);
  });
});

describe("buildDesiredScenes", () => {
  it("builds ME, TABLE, BOTH, BREAK in that order", () => {
    const desired = buildDesiredScenes(config);
    expect(desired.map((s) => s.sceneName)).toEqual(["ME", "TABLE", "BOTH", "BREAK"]);
  });

  it("BOTH scene contains both the table (background) and camera (inset) items", () => {
    const desired = buildDesiredScenes(config);
    const both = desired.find((s) => s.sceneName === "BOTH")!;
    expect(both.items.map((i) => i.sourceName).slice(0, 2).sort()).toEqual(["Capture Card", "Webcam"].sort());
  });

  it("falls back to the camera as the TABLE source when no capture card is chosen", () => {
    const noCard = buildDesiredScenes({ ...config, captureCard: null });
    const table = noCard.find((s) => s.sceneName === "TABLE")!;
    expect(table.items[0].sourceName).toBe("Webcam");
  });

  it("BREAK scene has exactly one card item and no camera/mic sources", () => {
    const desired = buildDesiredScenes(config);
    const brk = desired.find((s) => s.sceneName === "BREAK")!;
    expect(brk.items.length).toBe(1);
    expect(brk.items[0].sourceName).toBe(BREAK_CARD_SOURCE);
    expect(brk.items[0]).toMatchObject({
      transform: BREAK_CARD_TRANSFORM,
      inputSettings: BREAK_CARD_TEXT_SETTINGS,
      enabled: true,
    });
    const hidden = buildDesiredScenes(config, { breakCard: false }).find((s) => s.sceneName === "BREAK")!;
    expect(hidden.items[0].enabled).toBe(false);
    expect(BREAK_CARD_TEXT_SETTINGS.outline).toBe(true);
    expect(brk.items.some((i) => i.sourceName === ITEM_BAR_SOURCE)).toBe(false);
    expect(brk.items.some((i) => i.sourceName === SOLD_BANNER_SOURCE)).toBe(false);
  });

  it("puts a disabled Item Bar and SOLD Banner on every camera-facing scene, same names", () => {
    const desired = buildDesiredScenes(config);
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = desired.find((s) => s.sceneName === sceneName)!;
      const itemBar = scene.items.find((i) => i.sourceName === ITEM_BAR_SOURCE);
      const sold = scene.items.find((i) => i.sourceName === SOLD_BANNER_SOURCE);
      expect(itemBar).toMatchObject({
        sourceKind: TEXT_SOURCE_KIND,
        enabled: false,
        transform: ITEM_BAR_TRANSFORM,
        inputSettings: ITEM_BAR_TEXT_SETTINGS,
      });
      expect(sold).toMatchObject({
        sourceKind: TEXT_SOURCE_KIND,
        enabled: false,
        transform: SOLD_BANNER_TRANSFORM,
        inputSettings: SOLD_BANNER_TEXT_SETTINGS,
      });
      expect(sold?.inputSettings?.text).toBe(SOLD_BANNER_TEXT);
    }
  });

  it("places the item bar above the Whatnot bid bar and the SOLD banner above it", () => {
    const box = overlayBox("itemBar", "normal");
    expect(ITEM_BAR_TRANSFORM.positionY + box.height).toBeLessThanOrEqual(CANVAS_HEIGHT - WHATNOT_SAFE_BOTTOM);
    expect(SOLD_BANNER_TRANSFORM.positionY).toBeLessThan(ITEM_BAR_TRANSFORM.positionY);
    expect(ITEM_BAR_TEXT_SETTINGS.outline).toBe(true);
    expect(ITEM_BAR_TEXT_SETTINGS.bk_opacity).toBeGreaterThan(0);
    expect(SOLD_BANNER_TEXT_SETTINGS.outline).toBe(true);
    expect((SOLD_BANNER_TEXT_SETTINGS.font as { size: number }).size).toBeGreaterThan(
      (ITEM_BAR_TEXT_SETTINGS.font as { size: number }).size
    );
  });

  it("snap points sit in the named thirds and keep the box clear of Whatnot chrome on safe", () => {
    const top = overlaySnapTransform("itemBar", "top", "normal");
    const middle = overlaySnapTransform("itemBar", "middle", "normal");
    const bottom = overlaySnapTransform("itemBar", "bottom", "normal");
    const safe = overlaySnapTransform("itemBar", "safe", "normal");
    expect(top.positionY).toBe(WHATNOT_SAFE_TOP);
    expect(top.positionY).toBeLessThan(CANVAS_HEIGHT / 3);
    expect(middle.positionY).toBeGreaterThanOrEqual(CANVAS_HEIGHT / 3);
    expect(middle.positionY).toBeLessThan((CANVAS_HEIGHT * 2) / 3);
    expect(bottom.positionY).toBeGreaterThanOrEqual((CANVAS_HEIGHT * 2) / 3);
    expect(safe).toEqual(ITEM_BAR_TRANSFORM);
    expect(safe.positionY + 320).toBeLessThanOrEqual(CANVAS_HEIGHT - WHATNOT_SAFE_BOTTOM);
    expect(safe.positionY).toBeGreaterThanOrEqual(WHATNOT_SAFE_TOP);
    expect(ITEM_BAR_TRANSFORM.positionX).toBe(Math.round((CANVAS_WIDTH - 1000) / 2));
  });

  it("dropping on a snap point returns that snap's exact transform", () => {
    for (const snap of TEXT_SNAP_NAMES) {
      const t = overlaySnapTransform("soldBanner", snap, "normal");
      const found = nearestSnap("soldBanner", "normal", t.positionX, t.positionY);
      expect(found.snap).toBe(snap);
      expect(found.positionX).toBe(t.positionX);
      expect(found.positionY).toBe(t.positionY);
    }
  });

  it("warns when the fill cannot survive a black outline on a card mat", () => {
    expect(fillUnreadableOnMat(0xffffff)).toBe(false);
    expect(fillUnreadableOnMat(0x0028c8ff)).toBe(false);
    expect(fillUnreadableOnMat(0x000000)).toBe(true);
    expect(contrastRatio(0xffffff, 0x000000)).toBeGreaterThan(3);
    expect(cssHexToColorref("#FFC828")).toBe(0x0028c8ff);
    expect(overlaySourceName("itemBar")).toBe(ITEM_BAR_SOURCE);
    const style = overlayStyleSettings("itemBar", { colorref: 0x000000ff, size: "huge" });
    expect(style.color).toBe(0x000000ff);
    expect((style.font as { size: number }).size).toBeGreaterThan(72);
    expect(style.extents_cx).toBe(overlayBox("itemBar", "huge").width);
    expect(style.extents_cx as number).toBeGreaterThan(overlayBox("itemBar", "normal").width);
    expect(style).not.toHaveProperty("text");
    const smuggled = overlayStyleSettings("itemBar", {
      colorref: 0xffffff,
      size: "normal",
      text: "clobber me",
    } as { colorref: number; size: "normal" });
    expect(smuggled).not.toHaveProperty("text");
    expect(overlayInputSettings("itemBar", { colorref: 0xffffff, size: "normal", text: "keep me" }).text).toBe(
      "keep me"
    );
  });

  it("overlay box width scales with small/normal/huge and stays on the canvas", () => {
    const small = overlayBox("soldBanner", "small");
    const normal = overlayBox("soldBanner", "normal");
    const huge = overlayBox("soldBanner", "huge");
    expect(small.width).toBeLessThan(normal.width);
    expect(huge.width).toBeGreaterThan(normal.width);
    expect(huge.width).toBeLessThanOrEqual(CANVAS_WIDTH);
    expect(small.height).toBeLessThan(normal.height);
    expect(huge.height).toBeGreaterThan(normal.height);
  });

  it("BOTH split layout gives each camera half the canvas height", () => {
    const split = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_KIND", kind: "split" });
    const desired = buildDesiredScenes(config, undefined, split);
    const both = desired.find((s) => s.sceneName === "BOTH")!;
    const table = both.items.find((i) => i.sourceName === "Capture Card")!;
    const webcam = both.items.find((i) => i.sourceName === "Webcam")!;
    expect(table.transform).toEqual(bothCameraTransforms(split).table);
    expect(webcam.transform).toEqual(bothCameraTransforms(split).webcam);
    expect(table.transform.positionY).toBe(0);
    expect(webcam.transform.positionY).toBe(CANVAS_HEIGHT / 2);
    expect(transformInsideCanvas(table.transform)).toBe(true);
    expect(transformInsideCanvas(webcam.transform)).toBe(true);
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE).filter(
      (o) => o.type === "SetSceneItemTransform" && o.sceneName === "BOTH"
    );
    expect(ops).toEqual(
      expect.arrayContaining([
        {
          type: "SetSceneItemTransform",
          sceneName: "BOTH",
          sourceName: "Capture Card",
          transform: table.transform,
        },
        {
          type: "SetSceneItemTransform",
          sceneName: "BOTH",
          sourceName: "Webcam",
          transform: webcam.transform,
        },
      ])
    );
    expect(CANVAS_WIDTH).toBe(1080);
  });

  it("BOTH swap puts the webcam on the full canvas and the table in the inset", () => {
    const swapped = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SWAP" });
    const both = buildDesiredScenes(config, undefined, swapped).find((s) => s.sceneName === "BOTH")!;
    const webcam = both.items.find((i) => i.sourceName === "Webcam")!;
    const table = both.items.find((i) => i.sourceName === "Capture Card")!;
    expect(webcam.transform).toEqual(fullCanvasFillTransform());
    expect(table.transform).toEqual(bothCameraTransforms(swapped).table);
    expect(both.items[0].sourceName).toBe("Webcam");
    expect(both.items[1].sourceName).toBe("Capture Card");
  });

  it("creates each overlay input once and leaves it disabled after a full compile", () => {
    const desired = buildDesiredScenes(config);
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);
    for (const name of [ITEM_BAR_SOURCE, SOLD_BANNER_SOURCE]) {
      expect(ops.filter((o) => o.type === "CreateInput" && o.inputName === name)).toHaveLength(1);
    }
    const after = applyOpsToState(EMPTY_OBS_STATE, ops);
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = after.scenes.find((s) => s.name === sceneName)!;
      expect(scene.items.find((i) => i.sourceName === ITEM_BAR_SOURCE)?.enabled).toBe(false);
      expect(scene.items.find((i) => i.sourceName === SOLD_BANNER_SOURCE)?.enabled).toBe(false);
    }
  });
});
