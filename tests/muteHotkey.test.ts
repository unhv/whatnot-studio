import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createMuteHotkeyController,
  DEFAULT_MUTE_ACCELERATOR,
  liveMicrophoneBanner,
  MIC_OFF_BANNER,
  MUTE_HOTKEY_FAILED_COPY,
  muteHotkeyFromStored,
} from "../src/audio/muteHotkey.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("mute hotkey registration", () => {
  it("registers the default Control+Alt+M and fires one toggle callback", () => {
    const registered: string[] = [];
    let toggles = 0;
    const held: Array<() => void> = [];
    const ctl = createMuteHotkeyController({
      register: (accelerator, callback) => {
        registered.push(accelerator);
        held.push(callback);
        return true;
      },
      unregister: () => {},
      sendToggle: () => {
        toggles += 1;
      },
    });
    const status = ctl.set(DEFAULT_MUTE_ACCELERATOR);
    expect(status.registered).toBe(true);
    expect(status.message).toBeNull();
    expect(registered).toEqual(["Control+Alt+M"]);
    held[0]?.();
    expect(toggles).toBe(1);
  });

  it("surfaces a failed globalShortcut.register as the shortcut could not be set up", () => {
    const ctl = createMuteHotkeyController({
      register: () => false,
      unregister: () => {},
      sendToggle: () => {},
    });
    const status = ctl.set("Control+Alt+M");
    expect(status.registered).toBe(false);
    expect(status.message).toBe(MUTE_HOTKEY_FAILED_COPY);
    expect(status.message).toMatch(/the shortcut could not be set up/);
    expect(ctl.get().registered).toBe(false);
    expect(ctl.get().message).toBe(MUTE_HOTKEY_FAILED_COPY);
  });

  it("unregisters only the mute accelerator on release, not every global shortcut", () => {
    const unregistered: string[] = [];
    const ctl = createMuteHotkeyController({
      register: () => true,
      unregister: (accelerator) => {
        unregistered.push(accelerator);
      },
      sendToggle: () => {},
    });
    ctl.set("F8");
    ctl.releaseAll();
    expect(unregistered).toEqual(["F8"]);
    expect(ctl.get().registered).toBe(false);
  });

  it("rejects scene hotkeys so mute cannot steal F5", () => {
    const registered: string[] = [];
    const ctl = createMuteHotkeyController({
      register: (accelerator) => {
        registered.push(accelerator);
        return true;
      },
      unregister: () => {},
      sendToggle: () => {},
    });
    const status = ctl.set("F5");
    expect(status.accelerator).toBe(DEFAULT_MUTE_ACCELERATOR);
    expect(registered).toEqual([DEFAULT_MUTE_ACCELERATOR]);
    expect(muteHotkeyFromStored("F1")).toBe(DEFAULT_MUTE_ACCELERATOR);
  });
});

describe("LIVE mute banner", () => {
  it("is colour plus words, and only when muted", () => {
    expect(liveMicrophoneBanner(false)).toBeNull();
    expect(liveMicrophoneBanner(true)).toEqual({ text: MIC_OFF_BANNER });
    expect(MIC_OFF_BANNER).toBe("Your microphone is off");
    expect(MIC_OFF_BANNER).not.toMatch(/OBS|websocket|wasapi|input/i);
  });
});

describe("mute hotkey wiring in sources", () => {
  const main = readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  const live = readFileSync(path.join(root, "src", "renderer", "LiveScreen.tsx"), "utf8");
  const panel = readFileSync(path.join(root, "src", "renderer", "AudioPanel.tsx"), "utf8");

  it("registers in the main process, not as a renderer keydown", () => {
    expect(main).toMatch(/createMuteHotkeyController/);
    expect(main).toMatch(/will-quit/);
    expect(main).toMatch(/releaseAll/);
    expect(main).toMatch(/unregisterSceneHotkeys/);
    expect(main).not.toMatch(/unregisterAll/);
    expect(main).toMatch(/mainWindow\.on\("closed"/);
    expect(preload).toMatch(/onMuteHotkey/);
    expect(panel).not.toMatch(/keydown/i);
    expect(live).toContain("useLiveAudioSession");
    expect(panel).toContain("applyMuteHotkeyToggle");
    expect(panel).toContain("MUTE_HOTKEY_FAILED_COPY");
  });

  it("puts the muted indicator on LIVE, not inside AudioPanel", () => {
    expect(live).toContain("LiveMicrophoneOffBanner");
    expect(live).toContain("MIC_OFF_BANNER");
    expect(live).toMatch(/sticky/);
    expect(panel).not.toContain("Your microphone is off");
  });
});
