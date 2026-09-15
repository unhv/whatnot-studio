/**
 * Pure audio settings: which mic, desktop on/off, mute, named volume
 * steps. No OBS. Persistence is injectable so tests never need
 * localStorage. Desktop audio defaults off.
 */
import type { DeviceChoice } from "../shared/types.js";

export const AUDIO_SETTINGS_KEY = "whatnot-studio-audio";

export const VOLUME_STEPS = [
  { id: "quiet", label: "Quiet", mul: 0.4 },
  { id: "normal", label: "Normal", mul: 1 },
  { id: "loud", label: "Loud", mul: 1.5 },
] as const;

export type VolumeStepId = (typeof VOLUME_STEPS)[number]["id"];

export interface AudioSettings {
  micDeviceId: string | null;
  micLabel: string | null;
  desktopAudioOn: boolean;
  micMuted: boolean;
  micVolumeStep: VolumeStepId;
  desktopVolumeStep: VolumeStepId;
}

export function initialAudioSettings(): AudioSettings {
  return {
    micDeviceId: null,
    micLabel: null,
    desktopAudioOn: false,
    micMuted: false,
    micVolumeStep: "normal",
    desktopVolumeStep: "normal",
  };
}

export type AudioAction =
  | { type: "SELECT_MIC"; deviceId: string; label: string }
  | { type: "SET_DESKTOP_AUDIO"; on: boolean }
  | { type: "SET_MUTED"; muted: boolean }
  | { type: "SET_MIC_VOLUME"; step: VolumeStepId }
  | { type: "SET_DESKTOP_VOLUME"; step: VolumeStepId }
  | { type: "HYDRATE"; settings: AudioSettings };

export function audioReducer(state: AudioSettings, action: AudioAction): AudioSettings {
  switch (action.type) {
    case "SELECT_MIC":
      return { ...state, micDeviceId: action.deviceId, micLabel: action.label };
    case "SET_DESKTOP_AUDIO":
      return { ...state, desktopAudioOn: action.on };
    case "SET_MUTED":
      return { ...state, micMuted: action.muted };
    case "SET_MIC_VOLUME":
      return { ...state, micVolumeStep: action.step };
    case "SET_DESKTOP_VOLUME":
      return { ...state, desktopVolumeStep: action.step };
    case "HYDRATE":
      return { ...action.settings };
    default:
      return state;
  }
}

export function volumeMul(step: VolumeStepId): number {
  const found = VOLUME_STEPS.find((s) => s.id === step);
  return found?.mul ?? 1;
}

function isVolumeStepId(value: unknown): value is VolumeStepId {
  return VOLUME_STEPS.some((s) => s.id === value);
}

/** Coerce persisted JSON into settings. Unknown keys ignored; desktop
 * audio missing or invalid is off. */
export function parseAudioSettings(raw: unknown): AudioSettings {
  const base = initialAudioSettings();
  if (raw === null || typeof raw !== "object") return base;
  const rec = raw as Record<string, unknown>;
  return {
    micDeviceId: typeof rec.micDeviceId === "string" ? rec.micDeviceId : base.micDeviceId,
    micLabel: typeof rec.micLabel === "string" ? rec.micLabel : base.micLabel,
    desktopAudioOn: rec.desktopAudioOn === true,
    micMuted: rec.micMuted === true,
    micVolumeStep: isVolumeStepId(rec.micVolumeStep) ? rec.micVolumeStep : base.micVolumeStep,
    desktopVolumeStep: isVolumeStepId(rec.desktopVolumeStep) ? rec.desktopVolumeStep : base.desktopVolumeStep,
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadAudioSettings(storage: StorageLike | null | undefined): AudioSettings {
  if (!storage) return initialAudioSettings();
  try {
    const raw = storage.getItem(AUDIO_SETTINGS_KEY);
    if (!raw) return initialAudioSettings();
    return parseAudioSettings(JSON.parse(raw) as unknown);
  } catch {
    return initialAudioSettings();
  }
}

export function persistAudioSettings(
  settings: AudioSettings,
  storage: StorageLike | null | undefined
): void {
  if (!storage) return;
  try {
    storage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // quota / private mode — settings still live in memory this session
  }
}

/** The setup-screen mic is the same stored choice the panel must show.
 * When the store has a mic, it wins so the two screens cannot disagree. */
export function seedAudioSettings(persisted: AudioSettings, setupMic: DeviceChoice | null): AudioSettings {
  if (!setupMic) return persisted;
  return { ...persisted, micDeviceId: setupMic.deviceId, micLabel: setupMic.label };
}

export const AUDIO_COPY = {
  title: "Sound",
  yourMic: "Your microphone",
  disconnected: "Studio is not connected. Changes wait until it is.",
  mute: "Mute microphone",
  muted: "MUTED — they cannot hear you",
  desktop: "Let viewers hear my computer",
  unpluggedSuffix: "(unplugged)",
} as const;

export function deviceOptionLabel(label: string, gone: boolean): string {
  return gone ? `${label} ${AUDIO_COPY.unpluggedSuffix}` : label;
}
