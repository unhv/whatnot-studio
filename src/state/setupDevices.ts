/**
 * Setup-screen device copy and helpers. Kept pure so the OBS connection
 * states stay distinguishable in tests without rendering React.
 *
 * Five seller-facing situations: OBS not running, OBS running with the
 * websocket server off, wrong password, wrong port, and connected with
 * no cameras. Collapsing those is the defect this module exists to stop.
 */
import type { DeviceChoice } from "../shared/types.js";
import type { ObsConnectReason, ObsSetupAttempt } from "../obs/client.js";

export interface DeviceEnumState {
  connected: boolean;
  video: DeviceChoice[];
  audio: DeviceChoice[];
  /** Why we are not connected. Ignored when `connected` is true. */
  connectReason?: ObsConnectReason | null;
}

export function initialDeviceEnum(): DeviceEnumState {
  return { connected: false, video: [], audio: [], connectReason: "not-running" };
}

export const SETUP_OBS_NOT_CONNECTED = "Open OBS and leave it running, then press Try again";
export const SETUP_OBS_SERVER_DISABLED = "OBS is running, but it isn't letting us in yet";
export const SETUP_OBS_SERVER_DISABLED_HINT =
  "In OBS, open Tools -> WebSocket Server Settings and tick Enable WebSocket server, then press Try again.";
export const SETUP_OBS_AUTH_FAILED = "OBS is running, but it didn't accept our sign-in";
export const SETUP_OBS_AUTH_FAILED_HINT =
  "Press Try again. If it keeps happening, open Tools -> WebSocket Server Settings in OBS and choose Show Connect Info.";
export const SETUP_OBS_WRONG_PORT = "OBS is running, but not on the port we were told to use";
export const SETUP_OBS_WRONG_PORT_HINT =
  "In OBS, open Tools -> WebSocket Server Settings, then press Try again.";
export const SETUP_NO_CAMERAS = "No cameras found";
export const SETUP_NO_CAMERAS_HINT =
  "This usually means the camera is in use by another app, or unplugged.";
export const SETUP_NO_MICS = "No microphones found";
export const SETUP_NO_MICS_HINT =
  "This usually means the microphone is in use by another app, or unplugged.";
export const SETUP_WAITING_FOR_OBS = "Waiting for OBS…";
export const SETUP_SELECT = "Select…";
export const SETUP_TRY_AGAIN = "Try again";

export const SETUP_SHOW_TOOLS_HINT = "Paste your stream key on that page to go live.";
export const SETUP_COPY_OBS_PASSWORD_HINT =
  "This is the password OBS already has. We sign in with it for you.";

export type SetupDeviceKind =
  | "not-connected"
  | "server-disabled"
  | "auth-failed"
  | "wrong-port"
  | "no-cameras"
  | "ready";

export function setupDeviceKind(state: DeviceEnumState): SetupDeviceKind {
  if (state.connected) {
    if (state.video.length === 0) return "no-cameras";
    return "ready";
  }
  switch (state.connectReason) {
    case "server-disabled":
      return "server-disabled";
    case "auth-failed":
      return "auth-failed";
    case "wrong-port":
      return "wrong-port";
    default:
      return "not-connected";
  }
}

export interface SetupDeviceBanner {
  title: string;
  body: string | null;
}

/** The on-screen message for each failure state. Ready has no banner. */
export function setupDeviceBanner(state: DeviceEnumState): SetupDeviceBanner | null {
  const kind = setupDeviceKind(state);
  if (kind === "not-connected") {
    return { title: SETUP_OBS_NOT_CONNECTED, body: null };
  }
  if (kind === "server-disabled") {
    return { title: SETUP_OBS_SERVER_DISABLED, body: SETUP_OBS_SERVER_DISABLED_HINT };
  }
  if (kind === "auth-failed") {
    return { title: SETUP_OBS_AUTH_FAILED, body: SETUP_OBS_AUTH_FAILED_HINT };
  }
  if (kind === "wrong-port") {
    return { title: SETUP_OBS_WRONG_PORT, body: SETUP_OBS_WRONG_PORT_HINT };
  }
  if (kind === "no-cameras") {
    return { title: SETUP_NO_CAMERAS, body: SETUP_NO_CAMERAS_HINT };
  }
  return null;
}

export function deviceEnumFromAttempt(attempt: ObsSetupAttempt): DeviceEnumState {
  if (!attempt.ok) {
    return { connected: false, video: [], audio: [], connectReason: attempt.reason };
  }
  return {
    connected: true,
    video: attempt.video,
    audio: attempt.audio,
    connectReason: null,
  };
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
