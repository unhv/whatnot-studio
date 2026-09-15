import { describe, it, expect, vi } from "vitest";
import { runAppFirstRun, type FirstRunBridge } from "../src/obs/runSetup.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";

function makeBridge(overrides: Partial<FirstRunBridge> = {}): FirstRunBridge {
  return {
    firstRunPaths: vi.fn(async () => ({
      profileIniPath: "C:/appdata/profiles/Whatnot Studio/basic.ini",
      sceneCollectionJsonPath: "C:/appdata/scenes/Whatnot Studio.json",
      streamEncoderJsonPath: "C:/appdata/profiles/Whatnot Studio/streamEncoder.json",
    })),
    writeFirstRunFiles: vi.fn(async () => {}),
    launchObs: vi.fn(async () => ({ pid: 1234 })),
    closeObs: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runAppFirstRun", () => {
  it("wires the bridge into runFirstRunSetup and succeeds end to end against a fake OBS client", async () => {
    const bridge = makeBridge();
    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
      GetVersion: { obsVersion: "31.1.2" },
      SetVideoSettings: {},
      SetProfileParameter: {},
      GetProfileParameter: { parameterValue: "nvenc" },
    });

    const result = await runAppFirstRun({
      bridge,
      port: 4455,
      password: "pw",
      makeObsClient: () => client,
    });

    expect(result.ok).toBe(true);
    expect(bridge.firstRunPaths).toHaveBeenCalledWith("Whatnot Studio");
    const writeCalls = (bridge.writeFirstRunFiles as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const mainWrite = writeCalls.find((a) => a.profileIni);
    expect(mainWrite?.profileIni).toContain("Name=Whatnot Studio");
    expect(JSON.parse(mainWrite?.sceneCollectionJson ?? "{}").name).toBe("Whatnot Studio");
    const encoderWrites = writeCalls.filter((a) => a.streamEncoderJson);
    expect(encoderWrites.length).toBe(2);
    expect(JSON.parse(encoderWrites[0].streamEncoderJson)).toEqual({
      bitrate: 3500,
      keyint_sec: 2,
      rate_control: "CBR",
      tune: "zerolatency",
    });
    expect(bridge.launchObs).toHaveBeenCalledTimes(2); // initial + post-canvas restart
    expect(bridge.closeObs).toHaveBeenCalledTimes(1);
    expect(client.connectCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops on a mismatch and never calls closeObs or restarts", async () => {
    const bridge = makeBridge();
    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Untitled"], currentProfileName: "Untitled" },
      GetSceneCollectionList: { sceneCollections: ["Untitled"], currentSceneCollectionName: "Untitled" },
    });

    const result = await runAppFirstRun({
      bridge,
      port: 4455,
      password: "pw",
      makeObsClient: () => client,
    });

    expect(result.ok).toBe(false);
    expect(bridge.launchObs).toHaveBeenCalledTimes(1);
    expect(bridge.closeObs).not.toHaveBeenCalled();
  });
});
