import { describe, it, expect, vi } from "vitest";
import {
  buildFirstRunProfileIni,
  buildSceneCollectionSkeleton,
  runFirstRunSetup,
  verifyProfileAndCollection,
  type FirstRunDeps,
  type ProfileListResult,
  type SceneCollectionListResult,
} from "../src/obs/firstRun.js";
import { readIniSection } from "../spike/lib.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";

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
    const closeObs = vi.fn(async () => {});
    let launchCount = 0;
    const launch = vi.fn(async () => {
      launchCount++;
      return { pid: 1000 + launchCount };
    });

    const client = new FakeObsClient({
      GetProfileList: { profiles: ["Whatnot Studio"], currentProfileName: "Whatnot Studio" },
      GetSceneCollectionList: { sceneCollections: ["Whatnot Studio"], currentSceneCollectionName: "Whatnot Studio" },
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

    expect(result.ok).toBe(true);
    expect(written["C:/appdata/profiles/Whatnot Studio/basic.ini"]).toContain("Name=Whatnot Studio");
    expect(JSON.parse(written["C:/appdata/scene_collections/Whatnot Studio.json"]).name).toBe("Whatnot Studio");
    expect(launch).toHaveBeenCalledTimes(2); // initial launch + post-canvas restart
    expect(closeObs).toHaveBeenCalledTimes(1);
    expect(client.calls.some((c) => c.requestType === "SetVideoSettings")).toBe(true);
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
});
