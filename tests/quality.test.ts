import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import {
  applyHardwareEncoderOptIn,
  applyQualityChange,
  applyVideoQuality,
  chooseQualityPreset,
  clampWhatnotBitrate,
  ENCODER_REVERT_MESSAGE,
  foldEncoderGoLive,
  FORBIDDEN_OBS_REQUESTS,
  FORBIDDEN_PROFILE_PARAMS,
  getQualityPreset,
  HARDWARE_ENCODER_LABEL,
  isCameraMissingAfterApply,
  pendingEncoderWatch,
  QUALITY_PRESET_IDS,
  QUALITY_PRESETS,
  QUALITY_WHILE_LIVE,
  resolveQuality,
  revertHardwareEncoder,
  streamEncoderJsonForBitrate,
  sustainedKbpsFromSamples,
  WHATNOT_BITRATE_MAX_KBPS,
  WHATNOT_BITRATE_MIN_KBPS,
  type UploadProbeResult,
} from "../src/obs/quality.js";
import { applyWhatnotEncoderSettings, runFirstRunSetup, type FirstRunDeps } from "../src/obs/firstRun.js";
import { missingCameraMessage } from "../src/state/showStore.js";
import type { DeviceChoice } from "../src/shared/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function probe(partial: Partial<UploadProbeResult> & Pick<UploadProbeResult, "outcome">): UploadProbeResult {
  return { sustainedKbps: null, loadedRttMs: null, ...partial };
}

function profileParams(encoder = "x264") {
  return (data?: Record<string, unknown>) => {
    const category = data?.parameterCategory;
    const name = data?.parameterName;
    if (name === "Mode") return { parameterValue: "Simple" };
    if (category === "AdvOut" && (name === "Encoder" || name === "StreamEncoder")) {
      return { parameterValue: encoder === "x264" ? "obs_x264" : encoder };
    }
    if (name === "StreamEncoder" || name === "Encoder") return { parameterValue: encoder };
    return { parameterValue: null };
  };
}

function setParamCalls(client: FakeObsClient, parameterName: string) {
  return client.calls.filter(
    (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === parameterName
  );
}

function idleOutputs() {
  return {
    GetStreamStatus: { outputActive: false, outputSkippedFrames: 0, outputBytes: 0, outputCongestion: 0 },
    GetRecordStatus: { outputActive: false },
    GetVirtualCamStatus: { outputActive: false },
  };
}

describe("quality preset selection", () => {
  it("picks Best on a clean fast link", () => {
    expect(chooseQualityPreset(probe({ outcome: "ok", sustainedKbps: 20000, loadedRttMs: 40 }))).toBe("best");
  });

  it("picks Steady on a failed test", () => {
    expect(chooseQualityPreset(probe({ outcome: "failed", sustainedKbps: 50000, loadedRttMs: 10 }))).toBe("steady");
  });

  it("picks Steady on a timed-out test", () => {
    expect(chooseQualityPreset(probe({ outcome: "timeout", sustainedKbps: 50000, loadedRttMs: 10 }))).toBe("steady");
  });

  it("picks Steady when the test cannot run", () => {
    expect(chooseQualityPreset(probe({ outcome: "unavailable" }))).toBe("steady");
  });

  it("picks Steady on a fast-but-bufferbloated link", () => {
    expect(chooseQualityPreset(probe({ outcome: "ok", sustainedKbps: 25000, loadedRttMs: 400 }))).toBe("steady");
  });

  it("picks Steady when usable upload cannot hold 3500 plus audio", () => {
    // 4000 kbps raw * 0.8 = 3200 usable, below 3500+160
    expect(chooseQualityPreset(probe({ outcome: "ok", sustainedKbps: 4000, loadedRttMs: 40 }))).toBe("steady");
  });

  it("never falls back to Best from Automatic when the probe is missing numbers", () => {
    expect(chooseQualityPreset(probe({ outcome: "ok", sustainedKbps: null, loadedRttMs: 20 }))).toBe("steady");
  });

  it("honours a manual Best/Steady choice without using the probe as an oracle", () => {
    const failed = probe({ outcome: "failed" });
    expect(resolveQuality("best", failed)).toEqual({ preset: "best", summary: "Streaming at Best." });
    expect(resolveQuality("steady", failed)).toEqual({ preset: "steady", summary: "Streaming at Steady." });
    expect(resolveQuality("automatic", failed).preset).toBe("steady");
    expect(resolveQuality("automatic", failed).summary).toMatch(/Couldn't test your upload — streaming at Steady/);
    expect(
      resolveQuality("automatic", probe({ outcome: "ok", sustainedKbps: 20000, loadedRttMs: 30 })).summary
    ).toBe("Tested your upload — streaming at Best.");
  });
});

describe("Whatnot bitrate band", () => {
  it("no preset bitrate is outside 2500–3500", () => {
    for (const id of QUALITY_PRESET_IDS) {
      const bitrate = QUALITY_PRESETS[id].bitrateKbps;
      expect(bitrate).toBeGreaterThanOrEqual(WHATNOT_BITRATE_MIN_KBPS);
      expect(bitrate).toBeLessThanOrEqual(WHATNOT_BITRATE_MAX_KBPS);
    }
    expect(QUALITY_PRESET_IDS).toEqual(["best", "steady"]);
    expect(QUALITY_PRESETS.best.outputWidth).toBe(1080);
    expect(QUALITY_PRESETS.steady.outputWidth).toBe(720);
  });

  it("clamps every written bitrate into 2500–3500, defaulting low", () => {
    expect(clampWhatnotBitrate(1800)).toBe(2500);
    expect(clampWhatnotBitrate(1200)).toBe(2500);
    expect(clampWhatnotBitrate(9000)).toBe(3500);
    expect(clampWhatnotBitrate(Number.NaN)).toBe(2500);
    expect(streamEncoderJsonForBitrate(1800).bitrate).toBe(2500);
    expect(streamEncoderJsonForBitrate(8000).bitrate).toBe(3500);
  });

  it("applyWhatnotEncoderSettings cannot write a bitrate outside the band", async () => {
    const low = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams(),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
    });
    await applyWhatnotEncoderSettings(low, { bitrateKbps: 1200 });
    expect(setParamCalls(low, "VBitrate").every((c) => c.requestData?.parameterValue === "2500")).toBe(true);

    const high = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams(),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
    });
    await applyWhatnotEncoderSettings(high, { bitrateKbps: 9000 });
    expect(setParamCalls(high, "VBitrate").every((c) => c.requestData?.parameterValue === "3500")).toBe(true);
  });
});

describe("sustained upload is the minimum after slow-start, not the peak", () => {
  it("drops the slow-start window and takes the min remaining rate", () => {
    const samples = [
      { ms: 0, bytes: 0 },
      { ms: 1000, bytes: 2_000_000 },
      { ms: 2000, bytes: 3_000_000 },
      { ms: 3000, bytes: 3_250_000 },
      { ms: 4000, bytes: 3_450_000 },
    ];
    const kbps = sustainedKbpsFromSamples(samples, 2000);
    expect(kbps).toBeLessThan(4000);
    expect(kbps).toBeGreaterThan(1000);
  });
});

describe("SetVideoSettings is idle-only and re-enumerates", () => {
  const camera: DeviceChoice = { deviceId: "cam-1", label: "Face cam" };

  it("does not call SetVideoSettings while streaming, recording, or the virtual camera is active", async () => {
    for (const active of ["GetStreamStatus", "GetRecordStatus", "GetVirtualCamStatus"] as const) {
      const client = new FakeObsClient({
        ...idleOutputs(),
        [active]: { outputActive: true },
        SetVideoSettings: {},
        SetProfileParameter: {},
        GetProfileParameter: profileParams(),
        GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
      });
      const jsonWrites: string[] = [];
      const result = await applyQualityChange({
        obs: client,
        preset: getQualityPreset("steady"),
        camera,
        enumerate: async () => ({ video: [camera], audio: [] }),
        applyEncoderSettings: (obs) => applyWhatnotEncoderSettings(obs, { bitrateKbps: 2500 }),
        writeStreamEncoderJson: async (contents) => {
          jsonWrites.push(contents);
        },
      });
      expect(result.videoApplied).toBe(false);
      expect(result.videoSkipReason).toBe("output-active");
      expect(client.calls.some((c) => c.requestType === "SetVideoSettings")).toBe(false);
      expect(jsonWrites).toEqual([]);
    }
  });

  it("re-enumerates after a successful apply and routes a missing camera through the missing-camera path", async () => {
    const client = new FakeObsClient({
      ...idleOutputs(),
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams(),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
    });
    let enumerated = 0;
    const result = await applyQualityChange({
      obs: client,
      preset: getQualityPreset("steady"),
      camera,
      enumerate: async () => {
        enumerated += 1;
        return { video: [{ deviceId: "other", label: "Other cam" }], audio: [] };
      },
      applyEncoderSettings: (obs) => applyWhatnotEncoderSettings(obs, { bitrateKbps: 2500 }),
    });
    expect(client.calls.some((c) => c.requestType === "SetVideoSettings")).toBe(true);
    const videoCall = client.calls.find((c) => c.requestType === "SetVideoSettings");
    expect(videoCall?.requestData).toMatchObject({
      baseWidth: 1080,
      baseHeight: 1920,
      outputWidth: 720,
      outputHeight: 1280,
    });
    expect(enumerated).toBe(1);
    expect(result.cameraMissing).toBe(true);
    expect(isCameraMissingAfterApply(camera, result.devices.video)).toBe(true);
    expect(missingCameraMessage(camera)).toMatch(/Face cam isn't plugged in/);
  });
});

describe("quality and encoder writes hit both namespaces plus streamEncoder.json", () => {
  it("writes SimpleOutput and AdvOut and the encoder JSON, and never Output/Mode", async () => {
    const client = new FakeObsClient({
      ...idleOutputs(),
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams("x264"),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
    });
    const jsonWrites: string[] = [];
    await applyQualityChange({
      obs: client,
      preset: getQualityPreset("steady"),
      camera: null,
      enumerate: async () => ({ video: [], audio: [] }),
      applyEncoderSettings: (obs) => applyWhatnotEncoderSettings(obs, { bitrateKbps: 2500 }),
      writeStreamEncoderJson: async (contents) => {
        jsonWrites.push(contents);
      },
      hardwareEncoder: true,
    });

    const simple = client.calls.filter(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterCategory === "SimpleOutput"
    );
    const adv = client.calls.filter(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterCategory === "AdvOut"
    );
    expect(simple.some((c) => c.requestData?.parameterName === "VBitrate" && c.requestData?.parameterValue === "2500")).toBe(
      true
    );
    expect(simple.some((c) => c.requestData?.parameterName === "StreamEncoder")).toBe(true);
    expect(adv.some((c) => c.requestData?.parameterName === "Encoder")).toBe(true);
    expect(adv.some((c) => c.requestData?.parameterName === "AudioEncoder")).toBe(true);
    expect(JSON.parse(jsonWrites[0] ?? "{}")).toMatchObject({ bitrate: 2500, keyint_sec: 2 });
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetProfileParameter" &&
          c.requestData?.parameterCategory === "Output" &&
          c.requestData?.parameterName === "Mode"
      )
    ).toBe(false);
  });
});

describe("hardware encoder snapshot is the first software-to-hardware capture", () => {
  it("keeps a stored AMF snapshot when OBS already holds NVENC", async () => {
    const client = new FakeObsClient({
      GetProfileParameter: (data?: Record<string, unknown>) => {
        const category = data?.parameterCategory;
        const name = data?.parameterName;
        if (category === "AdvOut" && (name === "Encoder" || name === "StreamEncoder")) {
          return { parameterValue: "obs_nvenc_h264_tex" };
        }
        if (name === "StreamEncoder" || name === "Encoder") return { parameterValue: "nvenc" };
        return { parameterValue: null };
      },
      SetProfileParameter: {},
    });
    const applied = await applyHardwareEncoderOptIn(client, {
      simple: "amd",
      adv: "h264_texture_amf",
    });
    expect(applied.previous.simple).toBe("amd");
    expect(applied.previous.adv).toBe("h264_texture_amf");
    expect(applied.wrote).toBe(false);
  });

  it("applyQualityChange restores stored previous ids when the opt-in is cleared", async () => {
    const client = new FakeObsClient({
      ...idleOutputs(),
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams("nvenc"),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
    });
    await applyQualityChange({
      obs: client,
      preset: getQualityPreset("steady"),
      camera: null,
      enumerate: async () => ({ video: [], audio: [] }),
      applyEncoderSettings: (obs) => applyWhatnotEncoderSettings(obs, { bitrateKbps: 2500 }),
      hardwareEncoder: false,
      existingPreviousEncoders: { simple: "amd", adv: "h264_texture_amf" },
    });
    const simpleWrites = setParamCalls(client, "StreamEncoder");
    const advWrites = setParamCalls(client, "Encoder").filter(
      (c) => c.requestData?.parameterCategory === "AdvOut"
    );
    expect(simpleWrites[simpleWrites.length - 1]?.requestData?.parameterValue).toBe("amd");
    expect(advWrites[advWrites.length - 1]?.requestData?.parameterValue).toBe("h264_texture_amf");
  });
});

describe("hardware encoder opt-in reverts when Go Live produces no live stream", () => {
  it("reverts both encoder namespaces and reports in one sentence", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams("x264"),
    });
    const applied = await applyHardwareEncoderOptIn(client);
    expect(applied.previous.simple).toBe("x264");
    expect(setParamCalls(client, "StreamEncoder")[0]?.requestData?.parameterValue).toBe("nvenc");
    expect(setParamCalls(client, "Encoder")[0]?.requestData?.parameterValue).toBe("obs_nvenc_h264_tex");

    let watch = pendingEncoderWatch(applied.previous);
    watch = foldEncoderGoLive(watch, { outputState: "OBS_WEBSOCKET_OUTPUT_STARTING" }).next;
    const after = foldEncoderGoLive(watch, { outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
    expect(after.action).toBe("revert");
    await revertHardwareEncoder(client, after.next.previous);
    const simpleWrites = setParamCalls(client, "StreamEncoder");
    expect(simpleWrites[simpleWrites.length - 1]?.requestData?.parameterValue).toBe("x264");
    expect(ENCODER_REVERT_MESSAGE).toMatch(/switched it back/);
    expect(HARDWARE_ENCODER_LABEL).toMatch(/graphics card/);
  });

  it("keeps the opt-in when Go Live becomes live", () => {
    const watch = pendingEncoderWatch({ simple: "x264", adv: "obs_x264" });
    const starting = foldEncoderGoLive(watch, { outputState: "STARTING" });
    const live = foldEncoderGoLive(starting.next, { outputState: "STARTED" });
    expect(live.action).toBe("confirm");
    const stopped = foldEncoderGoLive(live.next, { outputState: "STOPPED" });
    expect(stopped.action).toBe("none");
  });
});

describe("this feature never starts, stops, or enables Dynamic Bitrate", () => {
  it("asserts it directly against a fake OBS client", async () => {
    const client = new FakeObsClient({
      ...idleOutputs(),
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams(),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
    });
    await applyVideoQuality(client, getQualityPreset("best"));
    await applyWhatnotEncoderSettings(client, { bitrateKbps: 3500 });
    const hw = await applyHardwareEncoderOptIn(client);
    await revertHardwareEncoder(client, hw.previous);
    await applyQualityChange({
      obs: client,
      preset: getQualityPreset("steady"),
      camera: null,
      enumerate: async () => ({ video: [], audio: [] }),
      applyEncoderSettings: (obs) => applyWhatnotEncoderSettings(obs, { bitrateKbps: 2500 }),
      hardwareEncoder: true,
    });

    const types = client.calls.map((c) => c.requestType);
    for (const forbidden of FORBIDDEN_OBS_REQUESTS) {
      expect(types).not.toContain(forbidden);
    }
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetProfileParameter" &&
          FORBIDDEN_PROFILE_PARAMS.includes(c.requestData?.parameterName as (typeof FORBIDDEN_PROFILE_PARAMS)[number])
      )
    ).toBe(false);
    expect(QUALITY_WHILE_LIVE).toMatch(/before the next show/);
  });

  it("the feature sources never call StartStream, StopStream, or write DynamicBitrate", () => {
    const files = [
      "src/obs/quality.ts",
      "src/obs/health.ts",
      "src/obs/firstRun.ts",
      "src/renderer/SetupScreen.tsx",
      "src/renderer/LiveScreen.tsx",
      "src/renderer/liveScreenSession.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(root, rel), "utf8");
      expect(src).not.toMatch(/\.call\(\s*["']StartStream["']/);
      expect(src).not.toMatch(/\.call\(\s*["']StopStream["']/);
      expect(src).not.toMatch(/parameterName:\s*["']DynamicBitrate["']/);
    }
  });
});

describe("first-run applies the chosen preset", () => {
  it("Steady writes 2500 and 720x1280, Best stays 3500 at 1080x1920", async () => {
    const written: Record<string, string> = {};
    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams("nvenc"),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
      ...idleOutputs(),
    });
    const deps: FirstRunDeps = {
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs: {
        async mkdir() {},
        async writeFile(filePath, contents) {
          written[filePath] = contents;
        },
        dirname: (filePath) => filePath.split(/[\\/]/).slice(0, -1).join("/"),
      },
      launch: async () => ({ pid: 1 }),
      connect: async () => client,
      closeObs: async () => {},
      qualityPreset: "steady",
    };
    const result = await runFirstRunSetup(deps);
    expect(result.ok).toBe(true);
    const video = client.calls.find((c) => c.requestType === "SetVideoSettings");
    expect(video?.requestData).toMatchObject({ outputWidth: 720, outputHeight: 1280, baseWidth: 1080, baseHeight: 1920 });
    expect(setParamCalls(client, "VBitrate")[0]?.requestData?.parameterValue).toBe("2500");
    expect(JSON.parse(written["C:/appdata/profiles/Whatnot Studio/streamEncoder.json"]).bitrate).toBe(2500);
  });

  it("restores stored previous encoders when hardware is off", async () => {
    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams("nvenc"),
      GetVideoSettings: { fpsNumerator: 30, fpsDenominator: 1 },
      ...idleOutputs(),
    });
    const result = await runFirstRunSetup({
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs: {
        async mkdir() {},
        async writeFile() {},
        dirname: (filePath) => filePath.split(/[\\/]/).slice(0, -1).join("/"),
      },
      launch: async () => ({ pid: 1 }),
      connect: async () => client,
      closeObs: async () => {},
      qualityPreset: "steady",
      hardwareEncoder: false,
      existingPreviousEncoders: { simple: "amd", adv: "h264_texture_amf" },
    });
    expect(result.ok).toBe(true);
    const simpleWrites = setParamCalls(client, "StreamEncoder");
    const advWrites = setParamCalls(client, "Encoder").filter(
      (c) => c.requestData?.parameterCategory === "AdvOut"
    );
    expect(simpleWrites[simpleWrites.length - 1]?.requestData?.parameterValue).toBe("amd");
    expect(advWrites[advWrites.length - 1]?.requestData?.parameterValue).toBe("h264_texture_amf");
  });
});
