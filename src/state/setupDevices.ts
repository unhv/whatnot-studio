/**
 * Setup-screen device copy and helpers. Kept pure so the three OBS
 * connection states stay distinguishable in tests without rendering
 * React: not connected, connected with no cameras, connected with cameras.
 */
import type { DeviceChoice } from "../shared/types.js";

export interface DeviceEnumState {
  connected: boolean;
  video: DeviceChoice[];
  audio: DeviceChoice[];
}

export function initialDeviceEnum(): DeviceEnumState {
  return { connected: false, video: [], audio: [] };
}

export const SETUP_OBS_NOT_CONNECTED = "Open OBS and leave it running, then press Try again";
export const SETUP_NO_CAMERAS = "No cameras found";
export const SETUP_NO_CAMERAS_HINT =
  "This usually means the camera is in use by another app, or unplugged.";
export const SETUP_NO_MICS = "No microphones found";
export const SETUP_NO_MICS_HINT =
  "This usually means the microphone is in use by another app, or unplugged.";
export const SETUP_WAITING_FOR_OBS = "Waiting for OBS…";
export const SETUP_SELECT = "Select…";
export const SETUP_TRY_AGAIN = "Try again";

export type SetupDeviceKind = "not-connected" | "no-cameras" | "ready";

export function setupDeviceKind(state: DeviceEnumState): SetupDeviceKind {
  if (!state.connected) return "not-connected";
  if (state.video.length === 0) return "no-cameras";
  return "ready";
}

export interface SetupDeviceBanner {
  title: string;
  body: string | null;
}

/** The on-screen message for each of the three states. Ready has no banner. */
export function setupDeviceBanner(state: DeviceEnumState): SetupDeviceBanner | null {
  const kind = setupDeviceKind(state);
  if (kind === "not-connected") {
    return { title: SETUP_OBS_NOT_CONNECTED, body: null };
  }
  if (kind === "no-cameras") {
    return { title: SETUP_NO_CAMERAS, body: SETUP_NO_CAMERAS_HINT };
  }
  return null;
}

export function deviceDropdownPlaceholder(
  connected: boolean,
  kind: "camera" | "mic" | "captureCard",
  count: number
): string {
  if (!connected) return SETUP_WAITING_FOR_OBS;
  if (count === 0) return kind === "mic" ? SETUP_NO_MICS : SETUP_NO_CAMERAS;
  return SETUP_SELECT;
}

/** Label for a device field. Never prints "(optional)" twice. */
export function deviceFieldLabel(label: string, optional?: boolean): string {
  if (!optional) return label;
  if (/\(\s*optional\s*\)/i.test(label)) return label;
  return `${label} (optional)`;
}

/** Pick the OBS-reported choice by ID. Returns that object unmodified. */
export function selectDeviceChoice(devices: DeviceChoice[], deviceId: string): DeviceChoice | null {
  if (deviceId === "") return null;
  return devices.find((d) => d.deviceId === deviceId) ?? null;
}
