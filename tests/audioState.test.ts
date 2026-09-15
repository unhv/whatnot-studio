import { describe, it, expect } from "vitest";
import {
  AUDIO_COPY,
  audioReducer,
  deviceOptionLabel,
  initialAudioSettings,
  loadAudioSettings,
  parseAudioSettings,
  persistAudioSettings,
  seedAudioSettings,
  volumeMul,
  type AudioSettings,
} from "../src/state/audio.js";

describe("audio settings", () => {
  it("defaults desktop audio off", () => {
    expect(initialAudioSettings().desktopAudioOn).toBe(false);
  });

  it("SELECT_MIC stores the friendly name, not an OBS kind", () => {
    const state = audioReducer(initialAudioSettings(), {
      type: "SELECT_MIC",
      deviceId: "headset-1",
      label: "Headset Mic",
    });
    expect(state.micDeviceId).toBe("headset-1");
    expect(state.micLabel).toBe("Headset Mic");
  });

  it("named volume steps map to multipliers, not dB", () => {
    expect(volumeMul("quiet")).toBe(0.4);
    expect(volumeMul("normal")).toBe(1);
    expect(volumeMul("loud")).toBe(1.5);
  });

  it("parseAudioSettings treats missing desktop audio as off", () => {
    expect(parseAudioSettings({ micDeviceId: "x", micLabel: "X" }).desktopAudioOn).toBe(false);
    expect(parseAudioSettings({ desktopAudioOn: "yes" }).desktopAudioOn).toBe(false);
    expect(parseAudioSettings({ desktopAudioOn: true }).desktopAudioOn).toBe(true);
  });

  it("round-trips through injectable storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const settings: AudioSettings = {
      ...initialAudioSettings(),
      micDeviceId: "headset-1",
      micLabel: "Headset Mic",
      desktopAudioOn: true,
      micMuted: true,
      micVolumeStep: "loud",
    };
    persistAudioSettings(settings, storage);
    expect(loadAudioSettings(storage)).toEqual(settings);
  });

  it("seeds the setup-screen mic so the panel cannot disagree", () => {
    const persisted = { ...initialAudioSettings(), micDeviceId: "old", micLabel: "Old" };
    const seeded = seedAudioSettings(persisted, { deviceId: "setup-mic", label: "Setup Mic" });
    expect(seeded.micDeviceId).toBe("setup-mic");
    expect(seeded.micLabel).toBe("Setup Mic");
  });

  it("marks an unplugged device in seller language", () => {
    expect(deviceOptionLabel("USB Mic", true)).toBe(`USB Mic ${AUDIO_COPY.unpluggedSuffix}`);
    expect(AUDIO_COPY.disconnected).not.toMatch(/websocket|OBS|wasapi/i);
    expect(AUDIO_COPY.desktop).toMatch(/computer/i);
  });
});
