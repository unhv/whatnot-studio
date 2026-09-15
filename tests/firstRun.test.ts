import { describe, it, expect, vi } from "vitest";
import {
  applyWhatnotEncoderSettings,
  buildFirstRunProfileIni,
  buildSceneCollectionSkeleton,
  buildWhatnotStreamEncoderJson,
  checkObsVersionWarning,
  keyintForIntervalSec,
  runFirstRunSetup,
  streamEncoderJsonPathFromProfileIni,
  switchToProfileAndCollection,
  verifyProfileAndCollection,
  type FirstRunDeps,
  type ProfileListResult,
  type SceneCollectionListResult,
} from "../src/obs/firstRun.js";
import { readIniSection } from "../spike/lib.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";

function profileParams(
  opts: {
    mode?: string | null;
    encoder?: string | null;
    simpleEncoder?: string | null;
    advEncoder?: string | null;
  } = {}
) {
  const mode = opts.mode === undefined ? "Simple" : opts.mode;
  const simpleEncoder = opts.simpleEncoder === undefined ? (opts.encoder ?? "nvenc") : opts.simpleEncoder;
  const advEncoder = opts.advEncoder === undefined ? (opts.encoder ?? "nvenc") : opts.advEncoder;
  return (data?: Record<string, unknown>) => {
    const category = data?.parameterCategory;
    const name = data?.parameterName;
    if (name === "Mode") return { parameterValue: mode };
    if (category === "AdvOut" && (name === "Encoder" || name === "StreamEncoder")) {
      return { parameterValue: advEncoder };
    }
    if (category === "SimpleOutput" && (name === "StreamEncoder" || name === "Encoder")) {
      return { parameterValue: simpleEncoder };
    }
    if (name === "StreamEncoder" || name === "Encoder") return { parameterValue: simpleEncoder };
    return { parameterValue: null };
  };
}

function setParamCalls(client: FakeObsClient, parameterName: string) {
  return client.calls.filter(
    (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === parameterName
  );
}

function videoSettings(fpsNumerator = 30, fpsDenominator = 1) {
  return { fpsNumerator, fpsDenominator };
}

describe("verifyProfileAndCollection", () => {
  it("passes when both current names match", () => {
    const profileList: ProfileListResult = { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" };
    const collectionList: SceneCollectionListResult = {
      sceneCollections: ["Whatnot Studio"],
      currentSceneCollectionName: "Whatnot Studio",
    };
    expect(verifyProfileAndCollection(profileList, collectionList, "Whatnot Studio")).toEqual({ ok: true });
  });

  it("is a stop condition when the profile doesn't match, even if the collection does", () => {
    const profileList: ProfileListResult = { profiles: ["Untitled"], currentProfileName: "Untitled" };
    const collectionList: SceneCollectionListResult = {
      sceneCollections: ["Whatnot Studio"],
      currentSceneCollectionName: "Whatnot Studio",
    };
    const result = verifyProfileAndCollection(profileList, collectionList, "Whatnot Studio");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Untitled/);
  });

  it("is a stop condition when the scene collection doesn't match, even if the profile does", () => {
    const profileList: ProfileListResult = { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" };
    const collectionList: SceneCollectionListResult = {
      sceneCollections: ["Untitled"],
      currentSceneCollectionName: "Untitled",
    };
    const result = verifyProfileAndCollection(profileList, collectionList, "Whatnot Studio");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Untitled/);
  });
});

describe("buildFirstRunProfileIni", () => {
  it("sets the product's profile name and the 1080x1920 canvas", () => {
    const ini = buildFirstRunProfileIni("Whatnot Studio");
    const general = readIniSection(ini, "General");
    const video = readIniSection(ini, "Video");
    expect(general.Name).toBe("Whatnot Studio");
    expect(video.BaseCX).toBe("1080");
    expect(video.BaseCY).toBe("1920");
  });
});

describe("buildSceneCollectionSkeleton", () => {
  it("carries the requested name and a valid current_scene", () => {
    const skeleton = buildSceneCollectionSkeleton("Whatnot Studio");
    expect(skeleton.name).toBe("Whatnot Studio");
    expect(skeleton.current_scene).toBe("Scene");
  });
});

describe("checkObsVersionWarning", () => {
  it("warns on any 32.x.x build", () => {
    expect(checkObsVersionWarning("32.0.0")).toMatch(/32\.0\.0/);
    expect(checkObsVersionWarning("32.5.1")).toMatch(/bitrate capped manually/);
  });

  it("is silent for non-32.x builds", () => {
    expect(checkObsVersionWarning("31.1.2")).toBeUndefined();
    expect(checkObsVersionWarning("30.2.3")).toBeUndefined();
  });
});

describe("buildWhatnotStreamEncoderJson", () => {
  it("puts Advanced bitrate/keyint/CBR/tune/preset on the encoder JSON keys OBS actually reads", () => {
    expect(buildWhatnotStreamEncoderJson()).toEqual({
      bitrate: 3500,
      keyint_sec: 2,
      rate_control: "CBR",
      tune: "zerolatency",
      preset: "veryfast",
    });
  });
});

describe("applyWhatnotEncoderSettings", () => {
  it("always caps SimpleOutput/VBitrate at 3500, regardless of encoder", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });
    await applyWhatnotEncoderSettings(client);
    const bitrateCalls = setParamCalls(client, "VBitrate");
    expect(bitrateCalls.length).toBeGreaterThan(0);
    expect(bitrateCalls.every((c) => c.requestData?.parameterValue === "3500")).toBe(true);
    expect(bitrateCalls.every((c) => c.requestData?.parameterCategory === "SimpleOutput")).toBe(true);
  });

  it("never writes x264-only settings for a non-x264 encoder, and says so", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });
    const result = await applyWhatnotEncoderSettings(client);
    expect(client.calls.some((c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === "x264Settings")).toBe(
      false
    );
    expect(result.encoderWarning).toMatch(/nvenc/);
    expect(result.encoderWarning).toMatch(/not x264/);
    expect(result.encoderWarning).toMatch(/3500/);
  });

  it("pins x264 keyint to 2 * fps (frames, not seconds)", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Simple", encoder: "x264" }),
      GetVideoSettings: videoSettings(30, 1),
    });
    await applyWhatnotEncoderSettings(client);
    const x264Calls = setParamCalls(client, "x264Settings");
    expect(x264Calls.length).toBeGreaterThan(0);
    for (const call of x264Calls) {
      expect(call.requestData?.parameterValue).toBe("keyint=60 tune=zerolatency");
    }
  });

  it("derives keyint from GetVideoSettings when the canvas is not 30 fps", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Simple", encoder: "obs_x264" }),
      GetVideoSettings: videoSettings(60, 1),
    });
    await applyWhatnotEncoderSettings(client);
    const x264Call = setParamCalls(client, "x264Settings")[0];
    expect(x264Call?.requestData?.parameterValue).toBe(`keyint=${2 * 60} tune=zerolatency`);
    expect(keyintForIntervalSec(60, 1)).toBe(120);
  });

  it("writes SimpleOutput ini keys when the profile is in Simple mode, not AdvOut video keys", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Simple", encoder: "x264" }),
      GetVideoSettings: videoSettings(),
    });
    await applyWhatnotEncoderSettings(client);
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "GetProfileParameter" &&
          c.requestData?.parameterCategory === "Output" &&
          c.requestData?.parameterName === "Mode"
      )
    ).toBe(true);
    const bitrateCalls = setParamCalls(client, "VBitrate");
    expect(bitrateCalls.map((c) => c.requestData?.parameterCategory)).toEqual(["SimpleOutput"]);
    const x264Calls = setParamCalls(client, "x264Settings");
    expect(x264Calls.map((c) => c.requestData?.parameterCategory)).toEqual(["SimpleOutput"]);
    const advWrites = client.calls.filter(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterCategory === "AdvOut"
    );
    expect(advWrites.map((c) => c.requestData?.parameterName)).toEqual(["AudioEncoder"]);
  });

  it("does not SetProfileParameter AdvOut/VBitrate — Advanced encode is streamEncoder.json", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Advanced", encoder: "obs_x264" }),
      GetVideoSettings: videoSettings(30, 1),
    });
    await applyWhatnotEncoderSettings(client);
    const advWrites = client.calls.filter(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterCategory === "AdvOut"
    );
    expect(advWrites.map((c) => `${c.requestData?.parameterName}=${c.requestData?.parameterValue}`)).toEqual([
      "AudioEncoder=ffmpeg_opus",
    ]);
    const bitrateCall = setParamCalls(client, "VBitrate")[0];
    expect(bitrateCall?.requestData?.parameterCategory).toBe("SimpleOutput");
    expect(bitrateCall?.requestData?.parameterValue).toBe("3500");
  });

  it("writes FFmpeg OPUS on AdvOut/AudioEncoder, not the decoy AdvOut/StreamAudioEncoder", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Advanced", encoder: "obs_x264" }),
      GetVideoSettings: videoSettings(),
    });
    await applyWhatnotEncoderSettings(client);
    const audioCalls = setParamCalls(client, "AudioEncoder");
    expect(audioCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestData: expect.objectContaining({
            parameterCategory: "AdvOut",
            parameterName: "AudioEncoder",
            parameterValue: "ffmpeg_opus",
          }),
        }),
      ])
    );
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetProfileParameter" &&
          c.requestData?.parameterCategory === "AdvOut" &&
          c.requestData?.parameterName === "StreamAudioEncoder"
      )
    ).toBe(false);
    const simpleAudio = setParamCalls(client, "StreamAudioEncoder");
    expect(simpleAudio.map((c) => `${c.requestData?.parameterCategory}=${c.requestData?.parameterValue}`)).toEqual([
      "SimpleOutput=opus",
    ]);
  });

  it("writes CPU usage preset where Advanced x264 actually reads it, not AdvOut/Preset", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Advanced", encoder: "obs_x264" }),
      GetVideoSettings: videoSettings(),
    });
    await applyWhatnotEncoderSettings(client);
    const simplePreset = setParamCalls(client, "Preset");
    expect(simplePreset.map((c) => `${c.requestData?.parameterCategory}=${c.requestData?.parameterValue}`)).toEqual([
      "SimpleOutput=veryfast",
    ]);
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetProfileParameter" &&
          (c.requestData?.parameterName === "Preset" || c.requestData?.parameterName === "x264Preset") &&
          c.requestData?.parameterCategory === "AdvOut"
      )
    ).toBe(false);
    expect(buildWhatnotStreamEncoderJson().preset).toBe("veryfast");
  });

  it("writes Simulcast Total Layers on Stream1/WHIPSimulcastTotalLayers and never SetStreamServiceSettings", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Advanced", encoder: "obs_x264" }),
      GetVideoSettings: videoSettings(),
    });
    await applyWhatnotEncoderSettings(client);
    const layerCalls = client.calls.filter(
      (c) =>
        c.requestType === "SetProfileParameter" &&
        c.requestData?.parameterCategory === "Stream1" &&
        c.requestData?.parameterName === "WHIPSimulcastTotalLayers"
    );
    expect(layerCalls).toHaveLength(1);
    expect(layerCalls[0]?.requestData?.parameterValue).toBe("1");
    expect(client.calls.some((c) => c.requestType === "SetStreamServiceSettings")).toBe(false);
    expect(
      client.calls.some(
        (c) =>
          c.requestType === "SetProfileParameter" &&
          (c.requestData?.parameterName === "TotalLayers" || c.requestData?.parameterName === "Simulcast")
      )
    ).toBe(false);
  });

  it("does not mirror Simple x264Settings onto AdvOut when AdvOut/Encoder is nvenc, and says so", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({
        mode: "Simple",
        simpleEncoder: "x264",
        advEncoder: "nvenc",
      }),
      GetVideoSettings: videoSettings(),
    });
    const result = await applyWhatnotEncoderSettings(client);
    const x264Calls = setParamCalls(client, "x264Settings");
    expect(x264Calls.map((c) => c.requestData?.parameterCategory)).toEqual(["SimpleOutput"]);
    expect(x264Calls[0]?.requestData?.parameterValue).toBe("keyint=60 tune=zerolatency");
    expect(result.encoderWarning).toMatch(/nvenc/);
    expect(result.encoderWarning).toMatch(/not x264/);
  });

  it("does not write Output/Mode", async () => {
    const client = new FakeObsClient({
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ mode: "Simple", encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });
    await applyWhatnotEncoderSettings(client);
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

function fakeFs() {
  const written: Record<string, string> = {};
  const mkdirCalls: string[] = [];
  return {
    written,
    mkdirCalls,
    fs: {
      async mkdir(dirPath: string) {
        mkdirCalls.push(dirPath);
      },
      async writeFile(filePath: string, contents: string) {
        written[filePath] = contents;
      },
      dirname(filePath: string) {
        return filePath.split(/[\\/]/).slice(0, -1).join("/");
      },
    },
  };
}

describe("runFirstRunSetup", () => {
  it("writes the profile/collection files, verifies, sets the canvas, then restarts", async () => {
    const { fs, written } = fakeFs();
    const events: string[] = [];
    const trackingFs = {
      ...fs,
      async writeFile(filePath: string, contents: string) {
        events.push(`write:${filePath}`);
        await fs.writeFile(filePath, contents);
      },
    };
    const closeObs = vi.fn(async () => {
      events.push("close");
    });
    let launchCount = 0;
    const launch = vi.fn(async () => {
      launchCount++;
      return { pid: 1000 + launchCount };
    });

    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });
    const connect = vi.fn(async () => client);

    const deps: FirstRunDeps = {
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs: trackingFs,
      launch,
      connect,
      closeObs,
    };

    const result = await runFirstRunSetup(deps);

    expect(result.ok).toBe(true);
    expect(result.versionWarning).toBeUndefined();
    expect(result.encoderWarning).toMatch(/nvenc/);
    expect(written["C:/appdata/profiles/Whatnot Studio/basic.ini"]).toContain("Name=Whatnot Studio");
    expect(JSON.parse(written["C:/appdata/scene_collections/Whatnot Studio.json"]).name).toBe("Whatnot Studio");
    expect(JSON.parse(written["C:/appdata/profiles/Whatnot Studio/streamEncoder.json"])).toEqual(
      buildWhatnotStreamEncoderJson()
    );
    expect(streamEncoderJsonPathFromProfileIni("C:/appdata/profiles/Whatnot Studio/basic.ini")).toBe(
      "C:/appdata/profiles/Whatnot Studio/streamEncoder.json"
    );
    const encoderPath = "C:/appdata/profiles/Whatnot Studio/streamEncoder.json";
    expect(events.filter((e) => e === "close" || e === `write:${encoderPath}`)).toEqual([
      `write:${encoderPath}`,
      "close",
      `write:${encoderPath}`,
    ]);
    expect(launch).toHaveBeenCalledTimes(2); // initial launch + post-canvas restart
    expect(closeObs).toHaveBeenCalledTimes(1);
    expect(client.calls.some((c) => c.requestType === "SetVideoSettings")).toBe(true);
    // the four Whatnot-required encoder settings: bitrate is always written,
    // the x264-only settings are skipped since this fake's encoder is nvenc
    const bitrateCall = client.calls.find(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === "VBitrate"
    );
    expect(bitrateCall?.requestData?.parameterValue).toBe("3500");
    expect(client.calls.some((c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === "x264Settings")).toBe(
      false
    );
  });

  it("warns when OBS reports a 32.x version", async () => {
    const { fs } = fakeFs();
    const closeObs = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ pid: 5000 }));

    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
      GetVersion: { obsVersion: "32.0.1" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });
    const connect = vi.fn(async () => client);

    const deps: FirstRunDeps = {
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs,
      launch,
      connect,
      closeObs,
    };

    const result = await runFirstRunSetup(deps);
    expect(result.ok).toBe(true);
    expect(result.versionWarning).toMatch(/32\.0\.1/);
    expect(result.versionWarning).toMatch(/bitrate capped manually/);
  });

  it("writes x264-specific settings when the seller's encoder is already x264", async () => {
    const { fs, written } = fakeFs();
    const closeObs = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ pid: 6000 }));

    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "x264" }),
      GetVideoSettings: videoSettings(),
    });
    const connect = vi.fn(async () => client);

    const deps: FirstRunDeps = {
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs,
      launch,
      connect,
      closeObs,
    };

    const result = await runFirstRunSetup(deps);
    expect(result.ok).toBe(true);
    expect(result.encoderWarning).toBeUndefined();
    const x264Call = client.calls.find(
      (c) => c.requestType === "SetProfileParameter" && c.requestData?.parameterName === "x264Settings"
    );
    expect(x264Call?.requestData?.parameterValue).toBe("keyint=60 tune=zerolatency");
    expect(x264Call?.requestData?.parameterCategory).toBe("SimpleOutput");
    expect(JSON.parse(written["C:/appdata/profiles/Whatnot Studio/streamEncoder.json"])).toEqual({
      bitrate: 3500,
      keyint_sec: 2,
      rate_control: "CBR",
      tune: "zerolatency",
      preset: "veryfast",
    });
    const audioCall = client.calls.find(
      (c) =>
        c.requestType === "SetProfileParameter" &&
        c.requestData?.parameterCategory === "AdvOut" &&
        c.requestData?.parameterName === "AudioEncoder"
    );
    expect(audioCall?.requestData?.parameterValue).toBe("ffmpeg_opus");
    const layersCall = client.calls.find(
      (c) =>
        c.requestType === "SetProfileParameter" && c.requestData?.parameterName === "WHIPSimulcastTotalLayers"
    );
    expect(layersCall?.requestData?.parameterCategory).toBe("Stream1");
    expect(layersCall?.requestData?.parameterValue).toBe("1");
  });

  it("stops on a profile/collection mismatch and never sets the canvas or restarts", async () => {
    const { fs } = fakeFs();
    const closeObs = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ pid: 4242 }));

    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Untitled"], currentProfileName: "Untitled" },
      GetSceneCollectionList: { sceneCollections: ["Untitled"], currentSceneCollectionName: "Untitled" },
      SetVideoSettings: {},
    });
    const connect = vi.fn(async () => client);

    const deps: FirstRunDeps = {
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs,
      launch,
      connect,
      closeObs,
    };

    const result = await runFirstRunSetup(deps);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Untitled/);
    expect(launch).toHaveBeenCalledTimes(1); // only the initial launch — no restart attempted
    expect(closeObs).not.toHaveBeenCalled();
    expect(client.calls.some((c) => c.requestType === "SetVideoSettings")).toBe(false);
  });

  it("reuses an already-running OBS, switches onto Whatnot Studio, and does not close it", async () => {
    let currentProfileName = "Untitled";
    let profiles = ["Untitled"];
    let currentSceneCollectionName = "Untitled";
    let sceneCollections = ["Untitled"];

    const { fs, written } = fakeFs();
    const closeObs = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ pid: 99, reused: true }));

    const client = new FakeObsClient({
      GetProfileList: () => ({ profiles: [...profiles], currentProfileName }),
      GetSceneCollectionList: () => ({
        sceneCollections: [...sceneCollections],
        currentSceneCollectionName,
      }),
      CreateProfile: (data?: Record<string, unknown>) => {
        currentProfileName = String(data?.profileName);
        if (!profiles.includes(currentProfileName)) profiles = [...profiles, currentProfileName];
        return {};
      },
      CreateSceneCollection: (data?: Record<string, unknown>) => {
        currentSceneCollectionName = String(data?.sceneCollectionName);
        if (!sceneCollections.includes(currentSceneCollectionName)) {
          sceneCollections = [...sceneCollections, currentSceneCollectionName];
        }
        return {};
      },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });
    const connect = vi.fn(async () => client);

    const deps: FirstRunDeps = {
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs,
      launch,
      connect,
      closeObs,
      alreadyRunning: true,
    };

    const result = await runFirstRunSetup(deps);

    expect(result.ok).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(closeObs).not.toHaveBeenCalled();
    expect(client.calls.some((c) => c.requestType === "CreateProfile")).toBe(true);
    expect(client.calls.some((c) => c.requestType === "CreateSceneCollection")).toBe(true);
    expect(client.calls.some((c) => c.requestType === "SetVideoSettings")).toBe(true);
    expect(written["C:/appdata/profiles/Whatnot Studio/basic.ini"]).toBeUndefined();
    expect(JSON.parse(written["C:/appdata/profiles/Whatnot Studio/streamEncoder.json"])).toEqual(
      buildWhatnotStreamEncoderJson()
    );
  });

  it("does not close or relaunch when launch() reports the port was already taken", async () => {
    let currentProfileName = "Untitled";
    let profiles = ["Untitled"];
    let currentSceneCollectionName = "Untitled";
    let sceneCollections = ["Untitled"];

    const { fs } = fakeFs();
    const closeObs = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ pid: 0, reused: true }));

    const client = new FakeObsClient({
      GetProfileList: () => ({ profiles: [...profiles], currentProfileName }),
      GetSceneCollectionList: () => ({
        sceneCollections: [...sceneCollections],
        currentSceneCollectionName,
      }),
      CreateProfile: (data?: Record<string, unknown>) => {
        currentProfileName = String(data?.profileName);
        if (!profiles.includes(currentProfileName)) profiles = [...profiles, currentProfileName];
        return {};
      },
      CreateSceneCollection: (data?: Record<string, unknown>) => {
        currentSceneCollectionName = String(data?.sceneCollectionName);
        if (!sceneCollections.includes(currentSceneCollectionName)) {
          sceneCollections = [...sceneCollections, currentSceneCollectionName];
        }
        return {};
      },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: profileParams({ encoder: "nvenc" }),
      GetVideoSettings: videoSettings(),
    });

    const result = await runFirstRunSetup({
      paths: {
        profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
        sceneCollectionJsonPath: "C:/appdata/scene_collections/Whatnot Studio.json",
      },
      fs,
      launch,
      connect: async () => client,
      closeObs,
    });

    expect(result.ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(closeObs).not.toHaveBeenCalled();
  });

  it("SetCurrentProfile when Whatnot Studio already exists on the running OBS", async () => {
    let currentProfileName = "Untitled";
    let currentSceneCollectionName = "Untitled";
    const client = new FakeObsClient({
      GetProfileList: () => ({
        profiles: ["Untitled", "Whatnot Studio"],
        currentProfileName,
      }),
      GetSceneCollectionList: () => ({
        sceneCollections: ["Untitled", "Whatnot Studio"],
        currentSceneCollectionName,
      }),
      SetCurrentProfile: (data?: Record<string, unknown>) => {
        currentProfileName = String(data?.profileName);
        return {};
      },
      SetCurrentSceneCollection: (data?: Record<string, unknown>) => {
        currentSceneCollectionName = String(data?.sceneCollectionName);
        return {};
      },
    });

    await switchToProfileAndCollection(client, "Whatnot Studio");
    const afterProfiles = await client.call<ProfileListResult>("GetProfileList");
    const afterCollections = await client.call<SceneCollectionListResult>("GetSceneCollectionList");
    expect(afterProfiles.currentProfileName).toBe("Whatnot Studio");
    expect(afterCollections.currentSceneCollectionName).toBe("Whatnot Studio");
    expect(client.calls.some((c) => c.requestType === "CreateProfile")).toBe(false);
    expect(client.calls.some((c) => c.requestType === "CreateSceneCollection")).toBe(false);
  });
});
