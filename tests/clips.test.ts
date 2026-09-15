import { describe, it, expect } from "vitest";
import {
  applySavedMeta,
  CLIP_VOLUME_STEPS,
  CLIPS_COPY,
  clipsReducer,
  clipVolumeMul,
  initialClipsState,
  loadClipsPersist,
  longClipWarning,
  persistClips,
  tidyLabel,
  type Clip,
  type ClipsAction,
} from "../src/state/clips.js";
import {
  defaultClipsDir,
  isSupportedClipExtension,
  scanClipsFolder,
  validateClip,
  type ClipsDirIo,
} from "../src/clips/scan.js";

function clip(partial: Partial<Clip> & Pick<Clip, "id" | "fileName" | "filePath">): Clip {
  return {
    label: tidyLabel(partial.fileName),
    usable: true,
    reason: null,
    durationMs: 3000,
    longWarning: null,
    volumeStep: "normal",
    ...partial,
  };
}

function drive(actions: ClipsAction[]) {
  let state = initialClipsState();
  for (const action of actions) state = clipsReducer(state, action);
  return state;
}

describe("clip scan and validation", () => {
  it("tidies a filename into a short label", () => {
    expect(tidyLabel("bad-draw-reaction.mp4")).toBe("Bad draw reaction");
    expect(tidyLabel("big_hit.webm")).toBe("Big hit");
  });

  it("lists an unsupported extension as unusable with seller language, not a throw", () => {
    expect(() =>
      validateClip({ fileName: "notes.txt", filePath: "C:\\\\clips\\\\notes.txt" })
    ).not.toThrow();
    const scanned = validateClip({ fileName: "notes.txt", filePath: "C:\\\\clips\\\\notes.txt" });
    expect(scanned.usable).toBe(false);
    expect(scanned.reason).toBe(CLIPS_COPY.unsupported);
    expect(isSupportedClipExtension("laugh.mp4")).toBe(true);
    expect(isSupportedClipExtension("laugh.gif")).toBe(true);
  });

  it("flags a clip longer than ~15s but still allows it", () => {
    const scanned = validateClip({
      fileName: "long-bit.mp4",
      filePath: "/clips/long-bit.mp4",
      durationMs: 22_000,
    });
    expect(scanned.usable).toBe(true);
    expect(scanned.longWarning).toBe(longClipWarning(22_000));
    expect(scanned.longWarning).toBe("this one is long -- it'll sit over your show for 22 seconds");
  });

  it("scan reports a missing file as unusable instead of throwing", async () => {
    const io: ClipsDirIo = {
      readdir: async () => ["gone.mp4", "ok.webm"],
      exists: async (path) => path.endsWith("ok.webm"),
      durationMs: async () => 2000,
    };
    const clips = await scanClipsFolder("C:\\\\Users\\\\seller\\\\clips", io);
    expect(clips).toHaveLength(2);
    const gone = clips.find((c) => c.fileName === "gone.mp4")!;
    expect(gone.usable).toBe(false);
    expect(gone.reason).toBe(CLIPS_COPY.missing);
    expect(clips.find((c) => c.fileName === "ok.webm")!.usable).toBe(true);
  });

  it("a missing folder is an empty list, not a throw", async () => {
    const io: ClipsDirIo = {
      readdir: async () => {
        throw new Error("ENOENT");
      },
      exists: async () => false,
    };
    await expect(scanClipsFolder("/nope", io)).resolves.toEqual([]);
  });

  it("puts clips under the app user-data directory", () => {
    expect(defaultClipsDir("C:\\Users\\seller\\AppData\\Roaming\\Whatnot Studio")).toBe(
      "C:\\Users\\seller\\AppData\\Roaming\\Whatnot Studio\\clips"
    );
  });

  it("a folder scan is the button list; persisted-only files that left the folder drop out", async () => {
    const io: ClipsDirIo = {
      readdir: async () => ["new.mp4"],
      exists: async () => true,
    };
    const scanned = await scanClipsFolder("C:\\clips", io);
    const listed = applySavedMeta(scanned, [
      { filePath: "C:\\clips\\old.mp4", label: "Old", volumeStep: "normal" },
      { filePath: scanned[0]!.filePath, label: "Crowd roar", volumeStep: "loud" },
    ]);
    expect(listed.map((c) => c.fileName)).toEqual(["new.mp4"]);
    expect(listed[0]?.label).toBe("Crowd roar");
  });
});

describe("clips reducer", () => {
  const a = clip({ id: "a.mp4", fileName: "a.mp4", filePath: "a.mp4" });
  const b = clip({ id: "b.mp4", fileName: "b.mp4", filePath: "b.mp4" });

  it("PLAY of the same clip twice stays on that clip (restart is the player's job)", () => {
    const state = drive([
      { type: "SET_CLIPS", clips: [a, b] },
      { type: "PLAY", id: "a.mp4" },
      { type: "PLAY", id: "a.mp4" },
    ]);
    expect(state.playingId).toBe("a.mp4");
    expect(state.error).toBeNull();
  });

  it("PLAY of a second clip replaces the first rather than queueing", () => {
    const state = drive([
      { type: "SET_CLIPS", clips: [a, b] },
      { type: "PLAY", id: "a.mp4" },
      { type: "PLAY", id: "b.mp4" },
    ]);
    expect(state.playingId).toBe("b.mp4");
  });

  it("PLAY of an unusable clip reports the reason and does not start", () => {
    const bad = validateClip({ fileName: "nope.txt", filePath: "nope.txt" });
    const state = drive([
      { type: "SET_CLIPS", clips: [bad] },
      { type: "PLAY", id: "nope.txt" },
    ]);
    expect(state.playingId).toBeNull();
    expect(state.error).toBe(CLIPS_COPY.unsupported);
  });

  it("PLAYBACK_ENDED clears the playing clip", () => {
    const state = drive([
      { type: "SET_CLIPS", clips: [a] },
      { type: "PLAY", id: "a.mp4" },
      { type: "PLAYBACK_ENDED" },
    ]);
    expect(state.playingId).toBeNull();
  });

  it("ERROR is seller language and stops playback without throwing", () => {
    expect(() =>
      clipsReducer(
        { ...initialClipsState(), clips: [a], playingId: "a.mp4" },
        { type: "ERROR", message: CLIPS_COPY.disconnected }
      )
    ).not.toThrow();
    const state = drive([
      { type: "SET_CLIPS", clips: [a] },
      { type: "PLAY", id: "a.mp4" },
      { type: "ERROR", message: CLIPS_COPY.missing },
    ]);
    expect(state.playingId).toBeNull();
    expect(state.error).toBe(CLIPS_COPY.missing);
  });

  it("MOVE reorders buttons", () => {
    const state = drive([
      { type: "SET_CLIPS", clips: [a, b] },
      { type: "MOVE", id: "b.mp4", direction: "up" },
    ]);
    expect(state.clips.map((c) => c.id)).toEqual(["b.mp4", "a.mp4"]);
  });

  it("named volume steps are multipliers, not dB", () => {
    expect(clipVolumeMul("quiet")).toBe(0.4);
    expect(CLIP_VOLUME_STEPS.map((s) => s.id)).toEqual(["quiet", "normal", "loud"]);
  });

  it("round-trips labels, order and mute through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const state = drive([
      { type: "SET_CLIPS", clips: [a, b] },
      { type: "SET_LABEL", id: "a.mp4", label: "Bad draw" },
      { type: "SET_VOLUME", id: "a.mp4", step: "loud" },
      { type: "SET_MUTED", muted: true },
    ]);
    persistClips(state, storage);
    const loaded = loadClipsPersist(storage);
    expect(loaded.muted).toBe(true);
    const merged = applySavedMeta([a, b], loaded.metas);
    expect(merged[0]?.label).toBe("Bad draw");
    expect(merged[0]?.volumeStep).toBe("loud");
  });
});
