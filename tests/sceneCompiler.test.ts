import { describe, it, expect } from "vitest";
import {
  applyOpsToState,
  buildDesiredScenes,
  compileScenePlan,
  EMPTY_OBS_STATE,
  fullCanvasFillTransform,
} from "../src/obs/sceneCompiler.js";
import type { ShowConfig } from "../src/shared/types.js";

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
                  ? { ...i, transform: { ...i.transform, positionX: i.transform.positionX + 50 } }
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
    expect(both.items.map((i) => i.sourceName).sort()).toEqual(["Capture Card", "Webcam"].sort());
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
    expect(brk.items[0].sourceName).toBe("BREAK Card");
  });
});
