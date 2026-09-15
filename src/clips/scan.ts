/**
 * Folder scan + validation for seller clip files. IO is injected so tests
 * never touch disk and the renderer never imports node:fs.
 */
import {
  CLIPS_COPY,
  LONG_CLIP_MS,
  longClipWarning,
  tidyLabel,
  type Clip,
} from "../state/clips.js";

export const CLIP_EXTENSIONS = [".mp4", ".webm", ".gif"] as const;

export const CLIPS_FOLDER_NAME = "clips";

export interface ClipsDirIo {
  readdir(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  durationMs?(path: string): Promise<number | null>;
  mkdir?(dir: string): Promise<void>;
}

export function defaultClipsDir(userDataDir: string): string {
  const base = userDataDir.replace(/[\\/]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}${CLIPS_FOLDER_NAME}`;
}

export function defaultUserDataDir(): string {
  const appData =
    typeof process !== "undefined" && process.env && typeof process.env.APPDATA === "string"
      ? process.env.APPDATA
      : "";
  if (!appData) return "";
  const sep = appData.includes("\\") ? "\\" : "/";
  return `${appData.replace(/[\\/]+$/, "")}${sep}Whatnot Studio`;
}

export function joinDir(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith("\\") || dir.endsWith("/") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Pick a free filename in a folder listing so a second drop does not overwrite. */
export function uniqueClipFileName(existingNames: string[], fileName: string): string {
  const base = fileName.replace(/^[\\/]+/, "").split(/[\\/]/).pop() ?? fileName;
  const lower = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  const ext = extensionOf(base);
  const stem = ext && base.toLowerCase().endsWith(ext) ? base.slice(0, base.length - ext.length) : base;
  const safeStem = stem || "clip";
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${safeStem}-${n}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${safeStem}-${Date.now()}${ext}`;
}

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i).toLowerCase() : "";
}

export function isSupportedClipExtension(fileName: string): boolean {
  return (CLIP_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

export function clipsDirFileUrl(dir: string): string {
  const normalized = dir.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return encodeURI(`file://${withSlash}`);
}

export function validateClip(input: {
  fileName: string;
  filePath: string;
  durationMs?: number | null;
  exists?: boolean;
}): Clip {
  const usableExt = isSupportedClipExtension(input.fileName);
  const exists = input.exists !== false;
  const durationMs = input.durationMs ?? null;
  let usable = usableExt && exists;
  let reason: string | null = null;
  if (!usableExt) {
    usable = false;
    reason = CLIPS_COPY.unsupported;
  } else if (!exists) {
    usable = false;
    reason = CLIPS_COPY.missing;
  }
  const longWarning =
    usable && durationMs !== null && durationMs > LONG_CLIP_MS ? longClipWarning(durationMs) : null;
  return {
    id: input.filePath,
    fileName: input.fileName,
    filePath: input.filePath,
    label: tidyLabel(input.fileName),
    usable,
    reason,
    durationMs,
    longWarning,
    volumeStep: "normal",
  };
}

/** List files in the clips folder. Missing folder → empty list, never throws. */
export async function scanClipsFolder(dir: string, io: ClipsDirIo): Promise<Clip[]> {
  if (io.mkdir) {
    try {
      await io.mkdir(dir);
    } catch {
      // still try to read; empty is the fallback
    }
  }

  let names: string[] = [];
  try {
    names = await io.readdir(dir);
  } catch {
    return [];
  }

  const clips: Clip[] = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;
    const filePath = joinDir(dir, name);
    let exists = true;
    try {
      exists = await io.exists(filePath);
    } catch {
      exists = false;
    }
    let durationMs: number | null = null;
    if (exists && io.durationMs && isSupportedClipExtension(name)) {
      try {
        durationMs = await io.durationMs(filePath);
      } catch {
        durationMs = null;
      }
    }
    clips.push(validateClip({ fileName: name, filePath, durationMs, exists }));
  }
  return clips;
}
