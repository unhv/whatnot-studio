import { describe, it, expect } from "vitest";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import { ClipPlayer, MEDIA_RESTART_ACTION, type ClipClock } from "../src/clips/player.js";
import { CAMERA_FACING_SCENES, CLIP_OVERLAY_SOURCE } from "../src/obs/sceneCompiler.js";
import { CLIPS_COPY, tidyLabel, type Clip } from "../src/state/clips.js";

class ManualClock implements ClipClock {
  nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, fn });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  advance(ms: number): void {
    this.nowMs += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

function makeClip(path: string, extras: Partial<Clip> = {}): Clip {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return {
    id: path,
    fileName,
    filePath: path,
    label: tidyLabel(fileName),
    usable: true,
    reason: null,
    durationMs: 3000,
    longWarning: null,
    volumeStep: "normal",
    ...extras,
  };
}

/** Square source: contain on 1080×1920 is scale 1, centred at (0, 420), no crop. */
const SQUARE_SOURCE = { sourceWidth: 1080, sourceHeight: 1080 };
const SQUARE_CONTAIN = {
  positionX: 0,
  positionY: 420,
  scaleX: 1,
  scaleY: 1,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
};

function makeClient(overrides?: ConstructorParameters<typeof FakeObsClient>[0]): FakeObsClient {
  return new FakeObsClient({
    GetSceneItemId: () => ({ sceneItemId: 7 }),
    GetSceneItemTransform: () => ({ sceneItemTransform: SQUARE_SOURCE }),
    SetSceneItemTransform: {},
    SetInputSettings: {},
    SetInputVolume: {},
    SetSceneItemEnabled: {},
    TriggerMediaInputAction: {},
    GetMediaInputStatus: { mediaState: "OBS_MEDIA_STATE_ENDED" },
    ...overrides,
  });
}

function playSequence(client: FakeObsClient) {
  return client.calls
    .filter(
      (c) =>
        c.requestType === "SetInputSettings" ||
        c.requestType === "SetSceneItemTransform" ||
        c.requestType === "SetSceneItemEnabled" ||
        c.requestType === "TriggerMediaInputAction"
    )
    .map((c) => ({ requestType: c.requestType, requestData: c.requestData }));
}

function enableCalls(enabled: boolean) {
  return CAMERA_FACING_SCENES.map((sceneName) => ({
    requestType: "SetSceneItemEnabled",
    requestData: { sceneName, sceneItemId: 7, sceneItemEnabled: enabled },
  }));
}

function settingsCall(filePath: string) {
  return {
    requestType: "SetInputSettings",
    requestData: {
      inputName: CLIP_OVERLAY_SOURCE,
      inputSettings: {
        is_local_file: true,
        local_file: filePath,
        looping: false,
        close_when_inactive: false,
      },
      overlay: true,
    },
  };
}

function fitCalls() {
  return CAMERA_FACING_SCENES.map((sceneName) => ({
    requestType: "SetSceneItemTransform",
    requestData: {
      sceneName,
      sceneItemId: 7,
      sceneItemTransform: SQUARE_CONTAIN,
    },
  }));
}

const restartCall = {
  requestType: "TriggerMediaInputAction",
  requestData: {
    inputName: CLIP_OVERLAY_SOURCE,
    mediaAction: MEDIA_RESTART_ACTION,
  },
};

describe("ClipPlayer against a fake OBS client", () => {
  it("press → SetInputSettings + SetSceneItemEnabled(true) + TriggerMediaInputAction, then MediaInputPlaybackEnded hides", async () => {
    const client = makeClient();
    const player = new ClipPlayer({ getClient: () => client });
    const clip = makeClip("C:\\\\clips\\\\bad-draw.mp4");

    player.play(clip, false);
    await player.idle();

    expect(playSequence(client)).toEqual([
      settingsCall(clip.filePath),
      ...fitCalls(),
      ...enableCalls(true),
      restartCall,
    ]);

    client.emit("MediaInputPlaybackEnded", { inputName: CLIP_OVERLAY_SOURCE });
    await player.idle();

    expect(playSequence(client)).toEqual([
      settingsCall(clip.filePath),
      ...fitCalls(),
      ...enableCalls(true),
      restartCall,
      ...enableCalls(false),
    ]);
    player.dispose();
  });

  it("the same clip pressed twice restarts rather than no-ops", async () => {
    const client = makeClient();
    const player = new ClipPlayer({ getClient: () => client });
    const clip = makeClip("C:\\\\clips\\\\bad-draw.mp4");

    player.play(clip, false);
    await player.idle();
    player.play(clip, false);
    await player.idle();

    const restarts = client.calls.filter((c) => c.requestType === "TriggerMediaInputAction");
    expect(restarts).toHaveLength(2);
    expect(playSequence(client)).toEqual([
      settingsCall(clip.filePath),
      ...fitCalls(),
      ...enableCalls(true),
      restartCall,
      settingsCall(clip.filePath),
      ...fitCalls(),
      ...enableCalls(true),
      restartCall,
    ]);
    player.dispose();
  });

  it("a second clip pressed mid-playback replaces the first", async () => {
    const client = makeClient({
      GetSceneItemId: () => ({ sceneItemId: 7 }),
      SetInputSettings: {},
      SetInputVolume: {},
      SetSceneItemEnabled: {},
      TriggerMediaInputAction: {},
      GetMediaInputStatus: { mediaState: "OBS_MEDIA_STATE_PLAYING" },
    });
    const player = new ClipPlayer({ getClient: () => client });
    const first = makeClip("C:\\\\clips\\\\bad-draw.mp4");
    const second = makeClip("C:\\\\clips\\\\big-hit.mp4");

    player.play(first, false);
    await player.idle();
    player.play(second, false);
    await player.idle();

    client.emit("MediaInputPlaybackEnded", { inputName: CLIP_OVERLAY_SOURCE });
    await player.idle();

    const settings = client.calls.filter((c) => c.requestType === "SetInputSettings");
    expect(settings).toHaveLength(2);
    expect(settings[1]?.requestData?.inputSettings).toMatchObject({ local_file: second.filePath });
    const hides = playSequence(client).filter(
      (c) => c.requestType === "SetSceneItemEnabled" && c.requestData?.sceneItemEnabled === false
    );
    expect(hides).toHaveLength(0);

    player.dispose();
  });

  it("a missing file on press is reported and does not throw or call OBS", async () => {
    const client = makeClient();
    const errors: string[] = [];
    const player = new ClipPlayer({
      getClient: () => client,
      fileExists: async () => false,
      onError: (message) => errors.push(message),
    });
    const clip = makeClip("C:\\\\clips\\\\deleted.mp4");

    expect(() => player.play(clip, false)).not.toThrow();
    await player.idle();
    expect(errors).toEqual([CLIPS_COPY.missing]);
    expect(playSequence(client)).toEqual([]);
    player.dispose();
  });

  it("an unsupported clip is reported and does not throw or call OBS", async () => {
    const client = makeClient();
    const errors: string[] = [];
    const player = new ClipPlayer({
      getClient: () => client,
      onError: (message) => errors.push(message),
    });
    const clip = makeClip("C:\\\\clips\\\\notes.txt", {
      usable: false,
      reason: CLIPS_COPY.unsupported,
    });

    expect(() => player.play(clip, false)).not.toThrow();
    await player.idle();
    expect(errors).toEqual([CLIPS_COPY.unsupported]);
    expect(playSequence(client)).toEqual([]);
    player.dispose();
  });

  it("survives OBS being disconnected during playback", async () => {
    const client = makeClient();
    const ended: string[] = [];
    const errors: string[] = [];
    const player = new ClipPlayer({
      getClient: () => client,
      onEnded: () => ended.push("ended"),
      onError: (message) => errors.push(message),
    });
    player.play(makeClip("C:\\\\clips\\\\bad-draw.mp4"), false);
    await player.idle();

    client.call = async () => {
      throw new Error("not connected");
    };
    expect(() => client.emit("ConnectionClosed")).not.toThrow();
    await expect(player.idle()).resolves.toBeUndefined();
    expect(ended).toEqual(["ended"]);

    expect(() => player.play(makeClip("C:\\\\clips\\\\big-hit.mp4"), false)).not.toThrow();
    await expect(player.idle()).resolves.toBeUndefined();
    expect(errors).toContain(CLIPS_COPY.disconnected);
    player.dispose();
  });

  it("pressing while OBS is disconnected reports it and does not throw", async () => {
    const errors: string[] = [];
    const player = new ClipPlayer({
      getClient: () => null,
      onError: (message) => errors.push(message),
    });
    expect(() => player.play(makeClip("C:\\\\clips\\\\bad-draw.mp4"), false)).not.toThrow();
    await player.idle();
    expect(errors).toEqual([CLIPS_COPY.disconnected]);
    player.dispose();
  });

  it("global mute sends volume 0 and does not touch a microphone source", async () => {
    const client = makeClient();
    const player = new ClipPlayer({ getClient: () => client });
    player.play(makeClip("C:\\\\clips\\\\bad-draw.mp4"), true);
    await player.idle();
    const volumes = client.calls.filter((c) => c.requestType === "SetInputVolume");
    expect(volumes).toEqual([
      {
        requestType: "SetInputVolume",
        requestData: { inputName: CLIP_OVERLAY_SOURCE, inputVolumeMul: 0 },
      },
    ]);
    expect(client.calls.some((c) => String(c.requestData?.inputName ?? "").toLowerCase().includes("mic"))).toBe(
      false
    );
    player.dispose();
  });

  it("a clip whose source dimensions cannot be read still plays and reports no error", async () => {
    const client = makeClient({
      GetSceneItemTransform: () => {
        throw new Error("no transform");
      },
    });
    const errors: string[] = [];
    const player = new ClipPlayer({
      getClient: () => client,
      onError: (message) => errors.push(message),
    });
    const clip = makeClip("C:\\\\clips\\\\bad-draw.mp4");

    player.play(clip, false);
    await player.idle();

    expect(errors).toEqual([]);
    expect(client.calls.some((c) => c.requestType === "SetSceneItemTransform")).toBe(false);
    expect(playSequence(client)).toEqual([
      settingsCall(clip.filePath),
      ...enableCalls(true),
      restartCall,
    ]);
    player.dispose();
  });

  it("safety timeout is a backstop that hides if the ended event never arrives", async () => {
    const client = makeClient();
    const clock = new ManualClock();
    const player = new ClipPlayer({ getClient: () => client, clock });
    player.play(makeClip("C:\\\\clips\\\\bad-draw.mp4", { durationMs: 1000 }), false);
    await player.idle();
    expect(playSequence(client).some((c) => c.requestData?.sceneItemEnabled === false)).toBe(false);
    clock.advance(10_999);
    await player.idle();
    expect(playSequence(client).some((c) => c.requestData?.sceneItemEnabled === false)).toBe(false);
    clock.advance(1);
    await player.idle();
    expect(playSequence(client).filter((c) => c.requestData?.sceneItemEnabled === false)).toHaveLength(
      CAMERA_FACING_SCENES.length
    );
    player.dispose();
  });
});
