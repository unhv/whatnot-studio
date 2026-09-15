import { describe, it, expect } from "vitest";
import {
  applyOpsToState,
  buildDesiredScenes,
  CAMERA_FACING_SCENES,
  CLIP_OVERLAY_KIND,
  CLIP_OVERLAY_SETTINGS,
  CLIP_OVERLAY_SOURCE,
  CLIP_OVERLAY_TRANSFORM,
  compileScenePlan,
  EMPTY_OBS_STATE,
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

describe("meme clip overlay in the scene plan", () => {
  it("puts a disabled ffmpeg_source covering the canvas on every camera-facing scene", () => {
    const desired = buildDesiredScenes(config);
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = desired.find((s) => s.sceneName === sceneName)!;
      const clip = scene.items.find((i) => i.sourceName === CLIP_OVERLAY_SOURCE);
      expect(clip).toMatchObject({
        sourceKind: CLIP_OVERLAY_KIND,
        enabled: false,
        transform: CLIP_OVERLAY_TRANSFORM,
        inputSettings: CLIP_OVERLAY_SETTINGS,
      });
    }
  });

  it("does not put the clip overlay on BREAK", () => {
    const desired = buildDesiredScenes(config);
    const brk = desired.find((s) => s.sceneName === "BREAK")!;
    expect(brk.items.some((i) => i.sourceName === CLIP_OVERLAY_SOURCE)).toBe(false);
  });

  it("creates the clip input once and leaves it disabled after a full compile", () => {
    const desired = buildDesiredScenes(config);
    const ops = compileScenePlan(desired, EMPTY_OBS_STATE);
    expect(ops.filter((o) => o.type === "CreateInput" && o.inputName === CLIP_OVERLAY_SOURCE)).toHaveLength(1);
    const create = ops.find((o) => o.type === "CreateInput" && o.inputName === CLIP_OVERLAY_SOURCE);
    expect(create).toMatchObject({ inputKind: CLIP_OVERLAY_KIND, sceneName: "ME" });
    const after = applyOpsToState(EMPTY_OBS_STATE, ops);
    for (const sceneName of CAMERA_FACING_SCENES) {
      const scene = after.scenes.find((s) => s.name === sceneName)!;
      expect(scene.items.find((i) => i.sourceName === CLIP_OVERLAY_SOURCE)?.enabled).toBe(false);
    }
  });
});
