/**
 * Named looping frames that sit under the camera. Pure list, geometry,
 * and path strings — no fs, so the renderer can import this. Disk checks
 * are injected by the compiler / tests.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../shared/types.js";

export const NONE_SURROUND_ID = "none" as const;

export const SURROUND_KIND_IDS = ["warm-glow", "cool-dusk", "soft-gold"] as const;
export type SurroundKindId = (typeof SURROUND_KIND_IDS)[number];

export const SURROUND_IDS = [NONE_SURROUND_ID, ...SURROUND_KIND_IDS] as const;
export type SurroundId = (typeof SURROUND_IDS)[number];

export const SURROUND_SOURCE_KIND = "ffmpeg_source";
export const SURROUND_ASSET_WIDTH = 270;
export const SURROUND_ASSET_HEIGHT = 480;
export const SURROUND_ASSET_EXT = ".mp4";

export interface SurroundRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CANVAS_RECT: SurroundRect = {
  x: 0,
  y: 0,
  w: CANVAS_WIDTH,
  h: CANVAS_HEIGHT,
};

/** Side inset `s` and matching vertical inset so the window stays 9:16. */
function portraitWindow(side: number): SurroundRect {
  const vert = Math.round((side * CANVAS_HEIGHT) / CANVAS_WIDTH);
  return {
    x: side,
    y: vert,
    w: CANVAS_WIDTH - side * 2,
    h: CANVAS_HEIGHT - vert * 2,
  };
}

export const SURROUND_COPY = {
  title: "Around the camera",
  none: "None",
  missing: "That frame isn't on this computer. Showing the camera on its own.",
} as const;

export interface SurroundDef {
  id: SurroundKindId;
  label: string;
  cameraRect: SurroundRect;
}

export const SURROUND_DEFS: readonly SurroundDef[] = [
  { id: "warm-glow", label: "Warm glow", cameraRect: portraitWindow(54) },
  { id: "cool-dusk", label: "Cool dusk", cameraRect: portraitWindow(72) },
  { id: "soft-gold", label: "Soft gold", cameraRect: portraitWindow(45) },
] as const;

export function isSurroundId(value: unknown): value is SurroundId {
  return SURROUND_IDS.some((id) => id === value);
}

export function parseSurroundId(raw: unknown): SurroundId {
  return isSurroundId(raw) ? raw : NONE_SURROUND_ID;
}

export function surroundDef(id: SurroundKindId): SurroundDef {
  const found = SURROUND_DEFS.find((d) => d.id === id);
  if (!found) return SURROUND_DEFS[0];
  return found;
}

export function surroundSourceName(id: SurroundKindId): string {
  return `Surround (${id})`;
}

export function isSurroundSourceName(name: string): boolean {
  return name.startsWith("Surround (") && name.endsWith(")");
}

export function joinDir(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** Node/test fallback. Production always passes `assetsDir` from main. */
export function defaultSurroundsDir(): string {
  const cwd =
    typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "";
  if (!cwd) return joinDir("assets", "surrounds");
  return joinDir(joinDir(cwd, "assets"), "surrounds");
}

interface SurroundAssetsApi {
  surroundsDir?: () => Promise<string>;
  clipsExists?: (filePath: string) => Promise<boolean>;
}

function surroundAssetsApi(): SurroundAssetsApi | null {
  try {
    const g = globalThis as {
      window?: { whatnotStudio?: SurroundAssetsApi };
      whatnotStudio?: SurroundAssetsApi;
    };
    return g.window?.whatnotStudio ?? g.whatnotStudio ?? null;
  } catch {
    return null;
  }
}

/**
 * Absolute surrounds folder from main, plus an exists check for `surroundId`.
 * Missing API (unit tests) returns `{}` so callers keep the node fallback.
 * A present API with a missing file degrades to none.
 */
export async function loadSurroundResolveOpts(surroundId?: unknown): Promise<SurroundResolveOpts> {
  const api = surroundAssetsApi();
  if (!api || typeof api.surroundsDir !== "function") return {};
  let assetsDir = "";
  try {
    assetsDir = await api.surroundsDir();
  } catch {
    assetsDir = "";
  }
  if (typeof assetsDir !== "string" || assetsDir === "") {
    return { exists: () => false };
  }
  const id = parseSurroundId(surroundId);
  if (id === NONE_SURROUND_ID || typeof api.clipsExists !== "function") {
    return { assetsDir };
  }
  const filePath = surroundAssetPath(id, assetsDir);
  let present = false;
  try {
    present = (await api.clipsExists(filePath)) === true;
  } catch {
    present = false;
  }
  return { assetsDir, exists: (p: string) => (p === filePath ? present : true) };
}

export function surroundAssetFileName(id: SurroundKindId): string {
  return `${id}${SURROUND_ASSET_EXT}`;
}

export function surroundAssetPath(id: SurroundKindId, assetsDir: string = defaultSurroundsDir()): string {
  return joinDir(assetsDir, surroundAssetFileName(id));
}

export function surroundInputSettings(filePath: string): Record<string, unknown> {
  return {
    is_local_file: true,
    local_file: filePath,
    looping: true,
    close_when_inactive: false,
    restart_on_activate: true,
    clear_on_media_end: false,
  };
}

export function surroundFillTransform(): {
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
} {
  return {
    positionX: 0,
    positionY: 0,
    scaleX: CANVAS_WIDTH / SURROUND_ASSET_WIDTH,
    scaleY: CANVAS_HEIGHT / SURROUND_ASSET_HEIGHT,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
  };
}

export interface ResolvedSurround {
  id: SurroundId;
  label: string;
  cameraRect: SurroundRect;
  filePath: string | null;
  sourceName: string | null;
  message: string | null;
}

export const NONE_SURROUND: ResolvedSurround = {
  id: NONE_SURROUND_ID,
  label: SURROUND_COPY.none,
  cameraRect: FULL_CANVAS_RECT,
  filePath: null,
  sourceName: null,
  message: null,
};

export interface SurroundResolveOpts {
  exists?: (filePath: string) => boolean;
  assetsDir?: string;
}

/**
 * `"none"` and a missing file both compile as today's unframed camera.
 * Never throws.
 */
export function resolveSurround(raw: unknown, opts?: SurroundResolveOpts): ResolvedSurround {
  try {
    const id = parseSurroundId(raw);
    if (id === NONE_SURROUND_ID) return NONE_SURROUND;
    const def = surroundDef(id);
    const filePath = surroundAssetPath(id, opts?.assetsDir ?? defaultSurroundsDir());
    const exists = opts?.exists ?? (() => true);
    let present = true;
    try {
      present = exists(filePath) === true;
    } catch {
      present = false;
    }
    if (!present) {
      return {
        ...NONE_SURROUND,
        message: SURROUND_COPY.missing,
      };
    }
    return {
      id,
      label: def.label,
      cameraRect: def.cameraRect,
      filePath,
      sourceName: surroundSourceName(id),
      message: null,
    };
  } catch {
    return NONE_SURROUND;
  }
}

export function mapRectIntoWindow(
  rect: SurroundRect,
  window: SurroundRect
): SurroundRect {
  if (
    window.x === 0 &&
    window.y === 0 &&
    window.w === CANVAS_WIDTH &&
    window.h === CANVAS_HEIGHT
  ) {
    return rect;
  }
  const sx = window.w / CANVAS_WIDTH;
  const sy = window.h / CANVAS_HEIGHT;
  return {
    x: window.x + rect.x * sx,
    y: window.y + rect.y * sy,
    w: rect.w * sx,
    h: rect.h * sy,
  };
}

export function pickerEntries(): { id: SurroundId; label: string }[] {
  return [
    { id: NONE_SURROUND_ID, label: SURROUND_COPY.none },
    ...SURROUND_DEFS.map((d) => ({ id: d.id as SurroundId, label: d.label })),
  ];
}
