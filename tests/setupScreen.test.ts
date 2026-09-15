import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  deviceDropdownPlaceholder,
  deviceFieldLabel,
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
    expect(src).toContain("startSetupDeviceSession");
    expect(src).toContain("SETUP_TRY_AGAIN");
    expect(src).toContain("retryRef.current");
  });
});
