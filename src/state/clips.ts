/**
 * Pure clip-button state: which files are on the pad, labels, volume,
 * mute, what's playing, and the last seller-facing error. No OBS.
 */

export const CLIPS_SETTINGS_KEY = "whatnot-studio-clips";

export const LONG_CLIP_MS = 15_000;

export const CLIP_VOLUME_STEPS = [
  { id: "quiet", label: "Quiet", mul: 0.4 },
  { id: "normal", label: "Normal", mul: 1 },
  { id: "loud", label: "Loud", mul: 1.5 },
] as const;

export type ClipVolumeStepId = (typeof CLIP_VOLUME_STEPS)[number]["id"];

export const CLIPS_COPY = {
  title: "Meme clips",
  openFolder: "Open clips folder",
  dropHint: "Drop mp4, webm or gif files in the clips folder.",
  empty: "No clips yet. Open the clips folder and drop a video in.",
  addClips: "Add clips",
  stop: "Stop clip",
  silentTonight: "Clips are silent tonight",
  disconnected: "Studio isn't connected — the clip didn't play",
  missing: "that clip's gone from the folder — drop it in again",
  unsupported: "this file isn't a clip we can play — drop an mp4, webm or gif",
  moveUp: "Move up",
  moveDown: "Move down",
} as const;

export function clipVolumeMul(step: ClipVolumeStepId): number {
  return CLIP_VOLUME_STEPS.find((s) => s.id === step)?.mul ?? 1;
}

export function tidyLabel(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return fileName;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function longClipWarning(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return `this one is long -- it'll sit over your show for ${seconds} seconds`;
}

export interface Clip {
  id: string;
  fileName: string;
  filePath: string;
  label: string;
  usable: boolean;
  reason: string | null;
  durationMs: number | null;
  longWarning: string | null;
  volumeStep: ClipVolumeStepId;
}

export interface ClipMeta {
  filePath: string;
  label: string;
  volumeStep: ClipVolumeStepId;
}

export interface ClipsState {
  clips: Clip[];
  muted: boolean;
  playingId: string | null;
  error: string | null;
}

export function initialClipsState(): ClipsState {
  return { clips: [], muted: false, playingId: null, error: null };
}

export type ClipsAction =
  | { type: "SET_CLIPS"; clips: Clip[] }
  | { type: "SET_LABEL"; id: string; label: string }
  | { type: "SET_VOLUME"; id: string; step: ClipVolumeStepId }
  | { type: "MOVE"; id: string; direction: "up" | "down" }
  | { type: "SET_MUTED"; muted: boolean }
  | { type: "PLAY"; id: string }
  | { type: "PLAYBACK_ENDED" }
  | { type: "ERROR"; message: string }
  | { type: "CLEAR_ERROR" }
  | { type: "HYDRATE"; state: Partial<ClipsState> };

function clipById(clips: Clip[], id: string): Clip | undefined {
  return clips.find((c) => c.id === id);
}

export function clipsReducer(state: ClipsState, action: ClipsAction): ClipsState {
  switch (action.type) {
    case "SET_CLIPS":
      return { ...state, clips: action.clips };

    case "SET_LABEL":
      return {
        ...state,
        clips: state.clips.map((c) => (c.id === action.id ? { ...c, label: action.label } : c)),
      };

    case "SET_VOLUME":
      return {
        ...state,
        clips: state.clips.map((c) => (c.id === action.id ? { ...c, volumeStep: action.step } : c)),
      };

    case "MOVE": {
      const i = state.clips.findIndex((c) => c.id === action.id);
      if (i < 0) return state;
      const j = action.direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= state.clips.length) return state;
      const clips = state.clips.slice();
      const tmp = clips[i]!;
      clips[i] = clips[j]!;
      clips[j] = tmp;
      return { ...state, clips };
    }

    case "SET_MUTED":
      return { ...state, muted: action.muted };

    case "PLAY": {
      const clip = clipById(state.clips, action.id);
      if (!clip) return { ...state, error: CLIPS_COPY.missing };
      if (!clip.usable) {
        return { ...state, error: clip.reason ?? CLIPS_COPY.unsupported };
      }
      return { ...state, playingId: clip.id, error: null };
    }

    case "PLAYBACK_ENDED":
      return { ...state, playingId: null };

    case "ERROR":
      return { ...state, error: action.message, playingId: null };

    case "CLEAR_ERROR":
      return { ...state, error: null };

    case "HYDRATE":
      return { ...state, ...action.state };

    default:
      return state;
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PersistedClips {
  muted: boolean;
  metas: ClipMeta[];
}

function isVolumeStep(value: unknown): value is ClipVolumeStepId {
  return CLIP_VOLUME_STEPS.some((s) => s.id === value);
}

export function parseClipsPersist(raw: unknown): PersistedClips {
  const empty: PersistedClips = { muted: false, metas: [] };
  if (raw === null || typeof raw !== "object") return empty;
  const rec = raw as Record<string, unknown>;
  const metasIn = Array.isArray(rec.metas) ? rec.metas : [];
  const metas: ClipMeta[] = [];
  for (const item of metasIn) {
    if (item === null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.filePath !== "string" || typeof m.label !== "string") continue;
    metas.push({
      filePath: m.filePath,
      label: m.label,
      volumeStep: isVolumeStep(m.volumeStep) ? m.volumeStep : "normal",
    });
  }
  return { muted: rec.muted === true, metas };
}

export function loadClipsPersist(storage: StorageLike | null | undefined): PersistedClips {
  if (!storage) return { muted: false, metas: [] };
  try {
    const raw = storage.getItem(CLIPS_SETTINGS_KEY);
    if (!raw) return { muted: false, metas: [] };
    return parseClipsPersist(JSON.parse(raw) as unknown);
  } catch {
    return { muted: false, metas: [] };
  }
}

export function persistClips(state: ClipsState, storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    const payload: PersistedClips = {
      muted: state.muted,
      metas: state.clips.map((c) => ({
        filePath: c.filePath,
        label: c.label,
        volumeStep: c.volumeStep,
      })),
    };
    storage.setItem(CLIPS_SETTINGS_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode — settings still live in memory this session
  }
}

/** Apply saved labels, volumes and order onto a fresh folder scan. */
export function applySavedMeta(clips: Clip[], metas: ClipMeta[]): Clip[] {
  if (metas.length === 0) return clips;
  const used = new Set<string>();
  const ordered: Clip[] = [];
  for (const m of metas) {
    const clip = clips.find((c) => c.filePath === m.filePath);
    if (!clip) continue;
    used.add(clip.id);
    ordered.push({
      ...clip,
      label: m.label.trim() === "" ? clip.label : m.label,
      volumeStep: m.volumeStep,
    });
  }
  for (const clip of clips) {
    if (used.has(clip.id)) continue;
    ordered.push(clip);
  }
  return ordered;
}
