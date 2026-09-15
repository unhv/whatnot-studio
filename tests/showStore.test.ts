import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceChoice, ShowConfig } from "../src/shared/types.js";
import { initialLiveState } from "../src/obs/liveMode.js";
import {
  decideLaunchScreen,
  EMPTY_SHOW_STORE,
  markLastUsed,
  missingCameraMessage,
  parseShowStore,
  resumePickedShow,
  serializeShowStore,
  showByName,
  showStoreToJson,
  upsertShow,
} from "../src/state/showStore.js";
import {
  DEFAULT_SHOW_CONFIG,
  persistableShowConfig,
  rehydrateAppStore,
  resumeCheckAfterDeviceEnum,
  useAppStore,
} from "../src/state/store.js";
import { initialDeviceEnum } from "../src/state/setupDevices.js";
import { payloadForDisk, writeShowStoreFileSync, readShowStoreFileSync } from "../electron/configStore.js";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CAMERA_LAYOUT_SETTINGS_KEY, loadCameraLayout } from "../src/state/cameraLayout.js";
import { loadTextStyle, textStyleStorageKey } from "../src/state/textStyle.js";

const camA: DeviceChoice = { deviceId: "cam-sat", label: "Elgato Facecam" };
const camB: DeviceChoice = { deviceId: "cam-snk", label: "Logitech Brio" };
const micA: DeviceChoice = { deviceId: "mic-sat", label: "Shure MV7" };
const micB: DeviceChoice = { deviceId: "mic-snk", label: "Rode Wireless" };

const SECRET = "super-secret-obs-pw-do-not-write";

function show(name: string, camera: DeviceChoice, mic: DeviceChoice): ShowConfig {
  return {
    ...DEFAULT_SHOW_CONFIG,
    showName: name,
    camera,
    mic,
    obsPassword: SECRET,
    obsPort: 4455,
  };
}

const saturday = show("Saturday Night Vintage", camA, micA);
const sneaker = show("Sneaker Drop", camB, micB);

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({
    screen: "setup",
    showConfig: { ...DEFAULT_SHOW_CONFIG },
    setupResumeMessage: null,
    live: initialLiveState(0),
  });
});

describe("named show store", () => {
  it("round-trips a saved config and never writes the OBS password", () => {
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    const json = showStoreToJson(stored);
    expect(json).not.toContain(SECRET);
    expect(json).not.toMatch(/obsPassword":\s*"[^"]+/);

    const loaded = parseShowStore(json);
    const found = showByName(loaded, "Saturday Night Vintage");
    expect(found).toBeTruthy();
    expect(found!.config.showName).toBe("Saturday Night Vintage");
    expect(found!.config.camera).toEqual(camA);
    expect(found!.config.mic).toEqual(micA);
    expect(found!.config.obsPassword).toBe("");
    expect(persistableShowConfig(saturday).obsPassword).toBe("");
    expect(serializeShowStore(stored).shows[0].config).toEqual(persistableShowConfig({ ...saturday, showName: "Saturday Night Vintage" }));

    const disk = payloadForDisk({ ...stored, shows: [{ ...stored.shows[0], config: saturday }] });
    expect(disk).not.toContain(SECRET);
    expect(JSON.parse(disk).shows[0].config.obsPassword).toBe("");
  });

  it("treats a missing, empty, or malformed store as a first run and does not throw", () => {
    for (const raw of [null, undefined, "", "{}", "{", "not-json", 12, [], { shows: "nope" }]) {
      expect(() => parseShowStore(raw)).not.toThrow();
      const parsed = parseShowStore(raw);
      expect(parsed.shows).toEqual([]);
      const decision = decideLaunchScreen(parsed);
      expect(decision.screen).toBe("setup");
      expect(decision.reason).toBe("first-run");
    }
    expect(() => rehydrateAppStore("{")).not.toThrow();
    expect(useAppStore.getState().screen).toBe("setup");
    expect(useAppStore.getState().showConfig.showName).toBe("");
  });

  it("opens LIVE when a stored show is still usable, and Setup when there is none", () => {
    const none = rehydrateAppStore(null);
    expect(none.screen).toBe("setup");
    expect(useAppStore.getState().screen).toBe("setup");

    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    const ready = rehydrateAppStore(stored, { enumerated: false, cameras: [] });
    expect(ready.screen).toBe("live");
    expect(ready.reason).toBe("ready");
    expect(useAppStore.getState().screen).toBe("live");
    expect(useAppStore.getState().showConfig.showName).toBe("Saturday Night Vintage");
    expect(useAppStore.getState().showConfig.camera).toEqual(camA);
    expect(useAppStore.getState().showConfig.obsPassword).toBe("");
  });

  it("sends the seller to Setup and names the camera when that device is gone", () => {
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    const decision = rehydrateAppStore(stored, {
      enumerated: true,
      cameras: [{ deviceId: "some-other-cam", label: "Phone cam" }],
    });
    expect(decision.screen).toBe("setup");
    expect(decision.reason).toBe("missing-camera");
    expect(decision.setupResumeMessage).toBe(missingCameraMessage(camA));
    expect(decision.setupResumeMessage).toMatch(/Elgato Facecam/);
    expect(decision.setupResumeMessage).toMatch(/isn't plugged in/);
    expect(useAppStore.getState().screen).toBe("setup");
    expect(useAppStore.getState().setupResumeMessage).toMatch(/Elgato Facecam/);
    expect(useAppStore.getState().showConfig.camera).toEqual(camA);
  });

  it("does not force Setup just because OBS has not enumerated devices yet", () => {
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    const decision = decideLaunchScreen(stored, { enumerated: false, cameras: [] });
    expect(decision.screen).toBe("live");
    expect(decision.reason).toBe("ready");
  });

  it("loads each show's own devices when switching between two saved shows", () => {
    let stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    stored = upsertShow(stored, sneaker);
    expect(stored.shows).toHaveLength(2);
    expect(showByName(stored, "Saturday Night Vintage")!.config.camera).toEqual(camA);
    expect(showByName(stored, "Saturday Night Vintage")!.config.mic).toEqual(micA);
    expect(showByName(stored, "Sneaker Drop")!.config.camera).toEqual(camB);
    expect(showByName(stored, "Sneaker Drop")!.config.mic).toEqual(micB);

    rehydrateAppStore(markLastUsed(stored, "Saturday Night Vintage"), { enumerated: false, cameras: [] });
    expect(useAppStore.getState().showConfig.camera).toEqual(camA);
    expect(useAppStore.getState().showConfig.mic).toEqual(micA);

    rehydrateAppStore(markLastUsed(stored, "Sneaker Drop"), { enumerated: false, cameras: [] });
    expect(useAppStore.getState().showConfig.camera).toEqual(camB);
    expect(useAppStore.getState().showConfig.mic).toEqual(micB);
    expect(useAppStore.getState().showConfig.showName).toBe("Sneaker Drop");
  });

  it("keeps the loaded config when going back to Setup from LIVE", () => {
    rehydrateAppStore(upsertShow(EMPTY_SHOW_STORE, saturday), { enumerated: false, cameras: [] });
    expect(useAppStore.getState().screen).toBe("live");
    useAppStore.getState().goToSetup();
    expect(useAppStore.getState().screen).toBe("setup");
    expect(useAppStore.getState().showConfig.showName).toBe("Saturday Night Vintage");
    expect(useAppStore.getState().showConfig.camera).toEqual(camA);
  });

  it("restores camera layout and text style onto localStorage when opening LIVE from disk", () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, String(v));
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
      clear: () => mem.clear(),
    });
    const layout = { kind: "split", main: "webcam", insetSize: "large", insetX: 24, insetY: 176 };
    const textStyle = {
      v: 1,
      overlays: {
        itemBar: { size: "huge", visible: true, snap: "top", positionX: 40, positionY: 200, colorref: 0x00ffffff },
      },
    };
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday, { cameraLayout: layout, textStyle });
    const decision = rehydrateAppStore(stored, { enumerated: false, cameras: [] });
    expect(decision.screen).toBe("live");
    expect(JSON.parse(mem.get(CAMERA_LAYOUT_SETTINGS_KEY)!)).toMatchObject(layout);
    expect(JSON.parse(mem.get(textStyleStorageKey("Saturday Night Vintage"))!)).toEqual(textStyle);
    expect(loadCameraLayout(localStorage).kind).toBe("split");
    expect(loadCameraLayout(localStorage).main).toBe("webcam");
    expect(loadTextStyle("Saturday Night Vintage").overlays.itemBar.size).toBe("huge");
  });
});

describe("resume-after-enumeration: a camera that vanishes while already on LIVE", () => {
  it("moves a resumed show from LIVE to Setup and names the missing device once OBS enumerates without it", () => {
    rehydrateAppStore(upsertShow(EMPTY_SHOW_STORE, saturday), { enumerated: false, cameras: [] });
    expect(useAppStore.getState().screen).toBe("live");

    const bounce = resumeCheckAfterDeviceEnum(useAppStore.getState(), {
      ...initialDeviceEnum(),
      connected: true,
      video: [{ deviceId: "some-other-cam", label: "Phone cam" }],
    });
    expect(bounce.screen).toBe("setup");
    expect(bounce.setupResumeMessage).toMatch(/Elgato Facecam/);

    useAppStore.getState().setDeviceEnum({
      ...initialDeviceEnum(),
      connected: true,
      video: [{ deviceId: "some-other-cam", label: "Phone cam" }],
    });
    expect(useAppStore.getState().screen).toBe("setup");
    expect(useAppStore.getState().setupResumeMessage).toMatch(/Elgato Facecam/);
  });

  it("does not bounce a resumed show off LIVE while OBS has not enumerated yet", () => {
    rehydrateAppStore(upsertShow(EMPTY_SHOW_STORE, saturday), { enumerated: false, cameras: [] });
    expect(useAppStore.getState().screen).toBe("live");

    const notEnumerated = resumeCheckAfterDeviceEnum(useAppStore.getState(), initialDeviceEnum());
    expect(notEnumerated.screen).toBeUndefined();

    useAppStore.getState().setDeviceEnum(initialDeviceEnum());
    expect(useAppStore.getState().screen).toBe("live");
    expect(useAppStore.getState().setupResumeMessage).toBeNull();
  });

  it("does not bounce LIVE when the enumerated list still includes the stored camera", () => {
    rehydrateAppStore(upsertShow(EMPTY_SHOW_STORE, saturday), { enumerated: false, cameras: [] });
    expect(useAppStore.getState().screen).toBe("live");

    useAppStore.getState().setDeviceEnum({ ...initialDeviceEnum(), connected: true, video: [camA] });
    expect(useAppStore.getState().screen).toBe("live");
    expect(useAppStore.getState().setupResumeMessage).toBeNull();
  });
});

describe("picking a saved show resumes it the same way boot does", () => {
  it("goes straight to LIVE when the picked show's camera is present and OBS is already connected", () => {
    let stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    stored = upsertShow(stored, sneaker);
    const picked = resumePickedShow(
      stored,
      "Saturday Night Vintage",
      { enumerated: true, cameras: [camA] },
      true
    );
    expect(picked).not.toBeNull();
    expect(picked!.goLive).toBe(true);
    expect(picked!.decision.screen).toBe("live");
    expect(picked!.next.lastUsedName).toBe("Saturday Night Vintage");
  });

  it("stays on Setup with the missing-camera banner when the picked show's camera is absent", () => {
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    const picked = resumePickedShow(
      stored,
      "Saturday Night Vintage",
      { enumerated: true, cameras: [camB] },
      true
    );
    expect(picked).not.toBeNull();
    expect(picked!.goLive).toBe(false);
    expect(picked!.decision.screen).toBe("setup");
    expect(picked!.decision.reason).toBe("missing-camera");
    expect(picked!.decision.setupResumeMessage).toMatch(/Elgato Facecam/);
  });

  it("stays on Setup, not a fault, when OBS is not connected yet even though the camera would be present", () => {
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    const picked = resumePickedShow(stored, "Saturday Night Vintage", { enumerated: false, cameras: [] }, false);
    expect(picked).not.toBeNull();
    expect(picked!.goLive).toBe(false);
    expect(picked!.decision.screen).toBe("live");
    expect(picked!.decision.reason).toBe("ready");
  });

  it("returns null for a name that is not in the saved list", () => {
    const stored = upsertShow(EMPTY_SHOW_STORE, saturday);
    expect(resumePickedShow(stored, "Nonexistent Show", { enumerated: false, cameras: [] }, true)).toBeNull();
  });
});

describe("payloadForDisk refuses a bad write instead of emptying the store", () => {
  it("throws on unparseable input rather than returning an empty-show payload", () => {
    expect(() => payloadForDisk("{not json")).toThrow();
  });

  it("leaves the existing shows.json untouched when the write payload cannot be parsed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "whatnot-configstore-"));
    const file = path.join(dir, "shows.json");
    const good = upsertShow(EMPTY_SHOW_STORE, saturday);
    writeShowStoreFileSync(file, good);
    const before = readFileSync(file, "utf8");
    expect(before).toContain("Saturday Night Vintage");

    expect(() => writeShowStoreFileSync(file, "{not json")).toThrow();

    const after = readFileSync(file, "utf8");
    expect(after).toBe(before);
    expect(readShowStoreFileSync(file)).not.toEqual({ version: 1, lastUsedName: null, shows: [] });
  });
});
