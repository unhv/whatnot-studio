import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  deviceDropdownPlaceholder,
  deviceFieldLabel,
  setupContinueAllowed,
  setupDeviceBanner,
  setupDeviceKind,
  SETUP_NO_CAMERAS,
  SETUP_NO_CAMERAS_HINT,
  SETUP_OBS_NOT_CONNECTED,
  SETUP_SELECT,
  SETUP_WAITING_FOR_OBS,
} from "../src/state/setupDevices.js";
import type { DeviceChoice } from "../src/shared/types.js";

const camera: DeviceChoice = { deviceId: "cam-obs-id", label: "Face cam" };

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "SetupScreen.tsx"),
  "utf8"
);

describe("setup screen — three distinguishable states", () => {
  it("not connected tells the seller to open OBS, and never says devices were not detected", () => {
    const state = { connected: false, video: [], audio: [] };
    expect(setupDeviceKind(state)).toBe("not-connected");
    expect(setupDeviceBanner(state)).toEqual({ title: SETUP_OBS_NOT_CONNECTED, body: null });
    expect(SETUP_OBS_NOT_CONNECTED).toMatch(/Open OBS and leave it running/);
    expect(SETUP_OBS_NOT_CONNECTED).toMatch(/Try again/);
    expect(SETUP_OBS_NOT_CONNECTED).not.toMatch(/No devices detected/i);
    expect(deviceDropdownPlaceholder(false, "camera", 0)).toBe(SETUP_WAITING_FOR_OBS);
    expect(deviceDropdownPlaceholder(false, "camera", 0)).not.toBe("No devices detected");
  });

  it("connected with no cameras says no cameras found and what that usually means", () => {
    const state = { connected: true, video: [], audio: [] };
    expect(setupDeviceKind(state)).toBe("no-cameras");
    expect(setupDeviceBanner(state)).toEqual({
      title: SETUP_NO_CAMERAS,
      body: SETUP_NO_CAMERAS_HINT,
    });
    expect(SETUP_NO_CAMERAS_HINT.toLowerCase()).toMatch(/in use by another app/);
    expect(SETUP_NO_CAMERAS_HINT.toLowerCase()).toMatch(/unplugged/);
    expect(deviceDropdownPlaceholder(true, "camera", 0)).toBe(SETUP_NO_CAMERAS);
    expect(deviceDropdownPlaceholder(true, "camera", 0)).not.toBe("No devices detected");
    expect(setupDeviceBanner(state)?.title).not.toBe(SETUP_OBS_NOT_CONNECTED);
  });

  it("connected with cameras shows the OBS list and not either empty-state message", () => {
    const state = { connected: true, video: [camera], audio: [] };
    expect(setupDeviceKind(state)).toBe("ready");
    expect(setupDeviceBanner(state)).toBeNull();
    expect(deviceDropdownPlaceholder(true, "camera", 1)).toBe(SETUP_SELECT);
    expect(deviceDropdownPlaceholder(true, "camera", 1)).not.toBe(SETUP_NO_CAMERAS);
    expect(deviceDropdownPlaceholder(true, "camera", 1)).not.toBe(SETUP_OBS_NOT_CONNECTED);
    expect(deviceDropdownPlaceholder(true, "camera", 1)).not.toBe("No devices detected");
  });

  it("the three state messages are pairwise distinct", () => {
    const a = setupDeviceBanner({ connected: false, video: [], audio: [] })?.title;
    const b = setupDeviceBanner({ connected: true, video: [], audio: [] })?.title;
    const c = deviceDropdownPlaceholder(true, "camera", 1);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(c).toBeTruthy();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("setup screen — (optional) is not duplicated", () => {
  it("prints Capture card (optional) once, even if the caller already included the word", () => {
    expect(deviceFieldLabel("Capture card", true)).toBe("Capture card (optional)");
    expect(deviceFieldLabel("Capture card (optional)", true)).toBe("Capture card (optional)");
    expect(deviceFieldLabel("Capture card (optional)", true)).not.toMatch(/\(optional\)\s*\(optional\)/);
  });

  it("SetupScreen uses deviceFieldLabel for the capture card and does not hardcode a double suffix", () => {
    expect(src).toContain('deviceFieldLabel("Capture card", true)');
    expect(src).not.toMatch(/Capture card \(optional\)"[\s\S]*optional/);
    expect(src).not.toContain("No devices detected");
    expect(src).toContain("setupDeviceBanner");
    expect(src).toContain("startObsSetupSession");
    expect(src).toContain("SETUP_TRY_AGAIN");
    expect(src).toContain("retryRef.current");
    expect(src).toMatch(/obsAlreadyRunning:\s*deviceEnum\.connected/);
  });
});

describe("setup screen — come back to a saved show", () => {
  it("renders a named-show picker and a start-a-new-show action", () => {
    expect(src).toContain("ShowPicker");
    expect(src).toContain("Your shows");
    expect(src).toContain("Start a new show");
    expect(src).toContain("pickSavedShow");
    expect(src).toContain("startNewShow");
    expect(src).toContain("saveShowStore");
    expect(src).toContain("persistableShowConfig");
    expect(src).toContain("setupResumeMessage");
  });

  it("hydrates the picker from loadShowStoreSync so first paint is not empty", () => {
    expect(src).toContain("loadShowStoreSync");
    expect(src).toContain("loadSavedShowsNow");
    expect(src).toMatch(/useState<ShowStoreState>\(loadSavedShowsNow\)/);
  });
});

describe("setup screen — Continue is disabled while a stored camera is known-missing", () => {
  it("setupContinueAllowed is false whenever storedCameraMissing is true, even with a name and camera set", () => {
    const camera: DeviceChoice = { deviceId: "cam-a", label: "Face cam" };
    expect(
      setupContinueAllowed({ showName: "Saturday", camera, starting: false, storedCameraMissing: true })
    ).toBe(false);
    expect(
      setupContinueAllowed({ showName: "Saturday", camera, starting: false, storedCameraMissing: false })
    ).toBe(true);
  });

  it("wires canContinue from setupResumeMessage and clears it via setSetupResumeMessage when picking a camera", () => {
    expect(src).toMatch(/storedCameraMissing:\s*setupResumeMessage\s*!==\s*null/);
    expect(src).toContain("setSetupResumeMessage(null)");
  });

  it("resumes a picked saved show through resumePickedShow, not a second ad-hoc rule", () => {
    expect(src).toContain("resumePickedShow");
    expect(src).toMatch(/if\s*\(picked\.goLive\)\s*goToLive\(\)/);
    expect(src).toContain("setSetupResumeMessage(picked.decision.setupResumeMessage)");
  });
});

describe("setup screen — Internet & quality", () => {
  it("renders the quality card with Automatic, Best, Steady, Re-test, and the graphics-card opt-in", () => {
    expect(src).toContain("Internet & quality");
    expect(src).toContain("Automatic (recommended)");
    expect(src).toContain("QualityCard");
    expect(src).toContain("HARDWARE_ENCODER_LABEL");
    expect(src).toContain("prepareQualityForGoLive");
    expect(src).toContain("handleRetest");
    expect(src).toContain("missingCameraMessage");
    expect(src).toContain("existingPreviousEncoders");
    expect(src).toContain("revertHardwareEncoder");
    // The rule is about seller-facing copy, not identifiers: `sustainedKbps`
    // and `bitrateKbps` are property names, not rendered labels. A word
    // boundary excludes those while still catching a real label like
    // "2500 Kbps".
    expect(src).not.toMatch(/\bKbps\b/);
    expect(src).not.toMatch(/\bkbps\b/);
  });
});
