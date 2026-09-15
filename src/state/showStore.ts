/**
 * Named list of seller shows. Load/save/validate live here so the
 * renderer, the boot path, and tests share one shape. Disk writes go
 * through persistableShowConfig so the OBS websocket password is never
 * stored as plain JSON.
 */
import type { DeviceChoice, ShowConfig } from "../shared/types.js";
import { CAMERA_LAYOUT_SETTINGS_KEY } from "./cameraLayout.js";
import { persistableShowConfig } from "./store.js";

/** Must match `textStyleStorageKey` in textStyle.ts. Inlined so this
 * module does not import textStyle (that file already imports the store). */
function textStyleKey(showName: string): string {
  return `whatnot-studio.textStyle.v1:${showName.trim()}`;
}

function browserLocalStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readLocalJson(key: string): unknown | null {
  const store = browserLocalStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeLocalJson(key: string, value: unknown): void {
  const store = browserLocalStorage();
  if (!store || value == null) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // quota / private mode
  }
}

/** Restore BOTH framing and overlay styles from a saved show onto localStorage
 * so LIVE's first paint (and Setup-for-edit) read this show, not defaults. */
export function applyShowExtras(show: PersistedShow): void {
  writeLocalJson(CAMERA_LAYOUT_SETTINGS_KEY, show.cameraLayout);
  writeLocalJson(textStyleKey(show.name), show.textStyle);
}

export function snapshotShowExtras(showName: string): {
  cameraLayout: unknown | null;
  textStyle: unknown | null;
} {
  return {
    cameraLayout: readLocalJson(CAMERA_LAYOUT_SETTINGS_KEY),
    textStyle: readLocalJson(textStyleKey(showName)),
  };
}

export const SHOW_STORE_VERSION = 1 as const;

export interface PersistedShow {
  name: string;
  config: ShowConfig;
  /** Snapshot of the BOTH-scene layout; restored onto localStorage on boot and pick. */
  cameraLayout: unknown | null;
  /** Snapshot of text overlays; restored onto the per-show localStorage key on boot and pick. */
  textStyle: unknown | null;
}

export interface ShowStoreState {
  version: typeof SHOW_STORE_VERSION;
  lastUsedName: string | null;
  shows: PersistedShow[];
}

export const EMPTY_SHOW_STORE: ShowStoreState = {
  version: SHOW_STORE_VERSION,
  lastUsedName: null,
  shows: [],
};

export type LaunchReason = "first-run" | "ready" | "missing-camera" | "unusable";

export interface DeviceEnumForLaunch {
  /**
   * False when OBS has not given us a list yet (not connected, or still
   * starting). Do not treat an unknown list as a missing camera.
   */
  enumerated: boolean;
  cameras: DeviceChoice[];
}

export interface LaunchDecision {
  screen: "setup" | "live";
  showConfig: ShowConfig;
  activeShowName: string | null;
  reason: LaunchReason;
  setupResumeMessage: string | null;
}

export function missingCameraMessage(camera: DeviceChoice): string {
  const name = camera.label.trim() || "That camera";
  return `${name} isn't plugged in. Plug it back in, or pick a different camera.`;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function parseDeviceChoice(raw: unknown): DeviceChoice | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (typeof rec.deviceId !== "string" || rec.deviceId === "") return null;
  if (typeof rec.label !== "string") return null;
  return { deviceId: rec.deviceId, label: rec.label };
}

function parsePort(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw < 65536) return raw;
  return 4455;
}

/** Accept a stored show config; always blank the password. */
export function parsePersistedShowConfig(raw: unknown): ShowConfig | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const showName = typeof rec.showName === "string" ? rec.showName : "";
  const camera = parseDeviceChoice(rec.camera);
  const mic = parseDeviceChoice(rec.mic);
  const captureCard = parseDeviceChoice(rec.captureCard);
  const config: ShowConfig = {
    showName,
    camera,
    mic,
    captureCard,
    obsPassword: typeof rec.obsPassword === "string" ? rec.obsPassword : "",
    obsPort: parsePort(rec.obsPort),
  };
  return persistableShowConfig(config);
}

function parsePersistedShow(raw: unknown): PersistedShow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const config = parsePersistedShowConfig(rec.config);
  if (!config) return null;
  const nameFromField = typeof rec.name === "string" ? rec.name.trim() : "";
  const name = nameFromField || config.showName.trim();
  if (!name) return null;
  return {
    name,
    config: persistableShowConfig({ ...config, showName: config.showName.trim() || name }),
    cameraLayout: rec.cameraLayout ?? null,
    textStyle: rec.textStyle ?? null,
  };
}

/**
 * Never throws. Missing, empty, or malformed input is a first run.
 */
export function parseShowStore(raw: unknown): ShowStoreState {
  try {
    const data = typeof raw === "string" ? (raw.trim() === "" ? null : JSON.parse(raw)) : raw;
    if (data == null) return { ...EMPTY_SHOW_STORE };
    const rec = asRecord(data);
    if (!rec) return { ...EMPTY_SHOW_STORE };
    const showsRaw = rec.shows;
    if (!Array.isArray(showsRaw)) return { ...EMPTY_SHOW_STORE };
    const shows: PersistedShow[] = [];
    for (const entry of showsRaw) {
      const parsed = parsePersistedShow(entry);
      if (parsed) shows.push(parsed);
    }
    const lastUsedName = typeof rec.lastUsedName === "string" && rec.lastUsedName.trim() !== ""
      ? rec.lastUsedName.trim()
      : null;
    return {
      version: SHOW_STORE_VERSION,
      lastUsedName,
      shows,
    };
  } catch {
    return { ...EMPTY_SHOW_STORE };
  }
}

export function serializeShowStore(state: ShowStoreState): ShowStoreState {
  const shows = state.shows.map((show) => ({
    name: show.name,
    config: persistableShowConfig(show.config),
    cameraLayout: show.cameraLayout ?? null,
    textStyle: show.textStyle ?? null,
  }));
  return {
    version: SHOW_STORE_VERSION,
    lastUsedName: state.lastUsedName,
    shows,
  };
}

export function showStoreToJson(state: ShowStoreState): string {
  return JSON.stringify(serializeShowStore(state));
}

export function showByName(state: ShowStoreState, name: string): PersistedShow | null {
  const needle = name.trim();
  if (!needle) return null;
  return state.shows.find((s) => s.name === needle) ?? null;
}

export function resolveActiveShow(state: ShowStoreState): PersistedShow | null {
  if (state.shows.length === 0) return null;
  if (state.lastUsedName) {
    const found = showByName(state, state.lastUsedName);
    if (found) return found;
  }
  return state.shows[state.shows.length - 1] ?? null;
}

export function storedCameraIsPresent(config: ShowConfig, cameras: DeviceChoice[]): boolean {
  if (!config.camera) return false;
  const id = config.camera.deviceId;
  return cameras.some((c) => c.deviceId === id);
}

export function upsertShow(
  state: ShowStoreState,
  config: ShowConfig,
  extras?: { cameraLayout?: unknown | null; textStyle?: unknown | null }
): ShowStoreState {
  const persisted = persistableShowConfig(config);
  const name = persisted.showName.trim();
  if (!name) return serializeShowStore(state);
  const entry: PersistedShow = {
    name,
    config: { ...persisted, showName: name },
    cameraLayout: extras?.cameraLayout ?? showByName(state, name)?.cameraLayout ?? null,
    textStyle: extras?.textStyle ?? showByName(state, name)?.textStyle ?? null,
  };
  const shows = state.shows.filter((s) => s.name !== name);
  shows.push(entry);
  return serializeShowStore({
    version: SHOW_STORE_VERSION,
    lastUsedName: name,
    shows,
  });
}

export function markLastUsed(state: ShowStoreState, name: string): ShowStoreState {
  const found = showByName(state, name);
  if (!found) return serializeShowStore(state);
  return serializeShowStore({ ...state, lastUsedName: found.name });
}

export const OBS_NOT_ENUMERATED: DeviceEnumForLaunch = { enumerated: false, cameras: [] };

/** Connected OBS has given us a list. Disconnected / still starting is not a list. */
export function deviceEnumForLaunch(connected: boolean, cameras: DeviceChoice[]): DeviceEnumForLaunch {
  if (!connected) return OBS_NOT_ENUMERATED;
  return { enumerated: true, cameras };
}

export function decideLaunchScreen(
  state: ShowStoreState,
  devices: DeviceEnumForLaunch = OBS_NOT_ENUMERATED
): LaunchDecision {
  const emptyConfig: ShowConfig = persistableShowConfig({
    showName: "",
    camera: null,
    mic: null,
    captureCard: null,
    obsPassword: "",
    obsPort: 4455,
  });
  const show = resolveActiveShow(state);
  if (!show) {
    return {
      screen: "setup",
      showConfig: emptyConfig,
      activeShowName: null,
      reason: "first-run",
      setupResumeMessage: null,
    };
  }
  const config = persistableShowConfig(show.config);
  const usableName = config.showName.trim() !== "";
  const hasCameraId = config.camera !== null && config.camera.deviceId !== "";
  if (!usableName || !hasCameraId) {
    return {
      screen: "setup",
      showConfig: config,
      activeShowName: show.name,
      reason: "unusable",
      setupResumeMessage: null,
    };
  }
  if (devices.enumerated && !storedCameraIsPresent(config, devices.cameras)) {
    return {
      screen: "setup",
      showConfig: config,
      activeShowName: show.name,
      reason: "missing-camera",
      setupResumeMessage: missingCameraMessage(config.camera!),
    };
  }
  return {
    screen: "live",
    showConfig: config,
    activeShowName: show.name,
    reason: "ready",
    setupResumeMessage: null,
  };
}

export function sessionCredentials(from: ShowConfig, disk: ShowConfig): ShowConfig {
  return {
    ...disk,
    obsPassword: from.obsPassword,
    obsPort: from.obsPort || disk.obsPort,
  };
}

/**
 * Picker path: same `decideLaunchScreen` rule as boot. LIVE only if that
 * rule says ready *and* OBS is already connected — otherwise the wizard
 * stays up. A disconnected OBS is not a missing-camera fault.
 */
export function resumePickedShow(
  state: ShowStoreState,
  name: string,
  devices: DeviceEnumForLaunch,
  obsConnected: boolean
): { next: ShowStoreState; decision: LaunchDecision; goLive: boolean } | null {
  if (!showByName(state, name)) return null;
  const next = markLastUsed(state, name);
  const decision = decideLaunchScreen(next, devices);
  return {
    next,
    decision,
    goLive: obsConnected && decision.screen === "live",
  };
}
