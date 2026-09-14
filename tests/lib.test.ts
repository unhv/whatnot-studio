import { describe, it, expect } from "vitest";
import {
  computeCropToFill,
  readIniSection,
  writeIniSection,
  buildMinimalProfileIni,
  slugifyObsName,
} from "../spike/lib.js";

describe("computeCropToFill", () => {
  it("crops a 16:9 source to fill a 9:16 portrait canvas, centered", () => {
    const t = computeCropToFill(1920, 1080, 1080, 1920);
    expect(t.cropTop).toBe(0);
    expect(t.cropBottom).toBe(0);
    expect(t.cropLeft).toBeCloseTo(656.25, 3);
    expect(t.cropRight).toBeCloseTo(656.25, 3);
    // remaining rect after crop, scaled, must exactly equal the target
    const remainingW = 1920 - t.cropLeft - t.cropRight;
    const remainingH = 1080 - t.cropTop - t.cropBottom;
    expect(remainingW * t.scaleX).toBeCloseTo(1080, 6);
    expect(remainingH * t.scaleY).toBeCloseTo(1920, 6);
    expect(t.scaleX).toBeCloseTo(t.scaleY, 6);
  });

  it("crops a portrait source to fill a landscape canvas", () => {
    const t = computeCropToFill(1080, 1920, 1920, 1080);
    expect(t.cropLeft).toBe(0);
    expect(t.cropRight).toBe(0);
    expect(t.cropTop).toBeGreaterThan(0);
    const remainingW = 1080 - t.cropLeft - t.cropRight;
    const remainingH = 1920 - t.cropTop - t.cropBottom;
    expect(remainingW * t.scaleX).toBeCloseTo(1920, 6);
    expect(remainingH * t.scaleY).toBeCloseTo(1080, 6);
  });

  it("applies no crop when source and target aspect already match", () => {
    const t = computeCropToFill(1080, 1920, 540, 960);
    expect(t.cropLeft).toBe(0);
    expect(t.cropRight).toBe(0);
    expect(t.cropTop).toBe(0);
    expect(t.cropBottom).toBe(0);
    expect(t.scaleX).toBeCloseTo(0.5, 6);
    expect(t.scaleY).toBeCloseTo(0.5, 6);
  });

  it("throws on non-positive dimensions", () => {
    expect(() => computeCropToFill(0, 1080, 1080, 1920)).toThrow();
    expect(() => computeCropToFill(1920, 1080, -1, 1920)).toThrow();
  });
});

describe("readIniSection / writeIniSection", () => {
  const sample = [
    "[General]",
    "FirstRun=true",
    "",
    "[Basic]",
    "Profile=Untitled",
    "ProfileDir=Untitled",
    "SceneCollection=Untitled",
    "SceneCollectionFile=Untitled",
    "",
    "[BasicWindow]",
    "gridMode=false",
    "",
  ].join("\n");

  it("reads only the requested section", () => {
    const basic = readIniSection(sample, "Basic");
    expect(basic.Profile).toBe("Untitled");
    expect(basic.SceneCollection).toBe("Untitled");
    expect(basic.FirstRun).toBeUndefined();
  });

  it("replaces keys in the target section without touching other sections", () => {
    const updated = writeIniSection(sample, "Basic", {
      Profile: "Whatnot Studio Spike",
      ProfileDir: "Whatnot Studio Spike",
      SceneCollection: "Whatnot Studio Spike",
      SceneCollectionFile: "Whatnot Studio Spike",
    });
    const basic = readIniSection(updated, "Basic");
    expect(basic.Profile).toBe("Whatnot Studio Spike");
    expect(basic.SceneCollectionFile).toBe("Whatnot Studio Spike");
    // other sections untouched
    const general = readIniSection(updated, "General");
    expect(general.FirstRun).toBe("true");
    const win = readIniSection(updated, "BasicWindow");
    expect(win.gridMode).toBe("false");
  });

  it("round-trips: writing the original values back restores the original section", () => {
    const changed = writeIniSection(sample, "Basic", {
      Profile: "Whatnot Studio Spike",
      ProfileDir: "Whatnot Studio Spike",
      SceneCollection: "Whatnot Studio Spike",
      SceneCollectionFile: "Whatnot Studio Spike",
    });
    const restored = writeIniSection(changed, "Basic", {
      Profile: "Untitled",
      ProfileDir: "Untitled",
      SceneCollection: "Untitled",
      SceneCollectionFile: "Untitled",
    });
    expect(readIniSection(restored, "Basic")).toEqual(readIniSection(sample, "Basic"));
  });

  it("inserts a missing key rather than dropping it", () => {
    const updated = writeIniSection(sample, "Basic", { NewKey: "value" });
    expect(readIniSection(updated, "Basic").NewKey).toBe("value");
    expect(readIniSection(updated, "Basic").Profile).toBe("Untitled");
  });

  it("appends a whole new section if it did not exist", () => {
    const updated = writeIniSection(sample, "DoesNotExist", { A: "1" });
    expect(readIniSection(updated, "DoesNotExist").A).toBe("1");
  });
});

describe("buildMinimalProfileIni", () => {
  it("produces a basic.ini with the requested canvas settings", () => {
    const ini = buildMinimalProfileIni({
      baseWidth: 1080,
      baseHeight: 1920,
      outputWidth: 1080,
      outputHeight: 1920,
      fpsNum: 30,
      fpsDen: 1,
    });
    const video = readIniSection(ini, "Video");
    expect(video.BaseCX).toBe("1080");
    expect(video.BaseCY).toBe("1920");
    expect(video.OutputCX).toBe("1080");
    expect(video.OutputCY).toBe("1920");
    expect(video.FPSNum).toBe("30");
  });
});

describe("slugifyObsName", () => {
  it("passes through a simple name unchanged", () => {
    expect(slugifyObsName("Whatnot Studio Spike")).toBe("Whatnot Studio Spike");
  });

  it("strips characters that are not filesystem-safe", () => {
    expect(slugifyObsName("Bad:/Name*?")).toBe("BadName");
  });
});
