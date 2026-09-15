/**
 * Pure logic used by the probe: no network, no filesystem, no child processes.
 * Kept separate from probe.ts so it can be unit tested without OBS running.
 */

export interface CropToFill {
  /** Source-space crop, in source pixels, applied before scale. */
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  /** Uniform scale applied to the cropped rect to fill the target exactly. */
  scaleX: number;
  scaleY: number;
  positionX: number;
  positionY: number;
}

/**
 * Compute a "cover" (crop-to-fill) transform that fills a target canvas
 * from a source of arbitrary aspect ratio, centered, with no letterboxing.
 *
 * Crop is applied in source pixels first (OBS applies item crop before
 * scale/position), then the remaining rect — which by construction has the
 * same aspect ratio as the target — is scaled uniformly to exactly the
 * target size and positioned at the origin.
 */
export function computeCropToFill(
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): CropToFill {
  if (sourceW <= 0 || sourceH <= 0 || targetW <= 0 || targetH <= 0) {
    throw new Error("computeCropToFill: all dimensions must be positive");
  }

  const sourceAspect = sourceW / sourceH;
  const targetAspect = targetW / targetH;

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;

  if (sourceAspect > targetAspect) {
    // Source is relatively wider than target: keep full height, crop the sides.
    const remainingH = sourceH;
    const remainingW = remainingH * targetAspect;
    const cropTotalW = sourceW - remainingW;
    cropLeft = cropTotalW / 2;
    cropRight = cropTotalW / 2;
  } else if (sourceAspect < targetAspect) {
    // Source is relatively taller than target: keep full width, crop top/bottom.
    const remainingW = sourceW;
    const remainingH = remainingW / targetAspect;
    const cropTotalH = sourceH - remainingH;
    cropTop = cropTotalH / 2;
    cropBottom = cropTotalH / 2;
  }
  // else: aspects already match, no crop needed.

  const remainingWFinal = sourceW - cropLeft - cropRight;
  const remainingHFinal = sourceH - cropTop - cropBottom;

  const scaleX = targetW / remainingWFinal;
  const scaleY = targetH / remainingHFinal;

  return {
    cropLeft,
    cropRight,
    cropTop,
    cropBottom,
    scaleX,
    scaleY,
    positionX: 0,
    positionY: 0,
  };
}

/**
 * Compute a "contain" transform: scale uniformly to fit inside the target,
 * centered, with no crop. Letterboxing is the point — framed meme content
 * must stay whole on a 9:16 canvas.
 */
export function computeContain(
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): CropToFill {
  if (sourceW <= 0 || sourceH <= 0 || targetW <= 0 || targetH <= 0) {
    throw new Error("computeContain: all dimensions must be positive");
  }

  const scale = Math.min(targetW / sourceW, targetH / sourceH);
  const scaledW = sourceW * scale;
  const scaledH = sourceH * scale;

  return {
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
    scaleX: scale,
    scaleY: scale,
    positionX: (targetW - scaledW) / 2,
    positionY: (targetH - scaledH) / 2,
  };
}

/** Minimal INI-style key=value reader, scoped to a single [Section]. */
export function readIniSection(text: string, section: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const result: Record<string, string> = {};
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.slice(1, -1) === section;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Replace (or insert) key=value pairs inside a single [Section] of an INI
 * file's text, leaving every other line — including other sections and the
 * BOM, if present — byte-for-byte untouched. Used to snapshot/restore
 * obs-studio's global.ini [Basic] Profile/SceneCollection selection so the
 * user's own default is never left pointed at the spike.
 */
export function writeIniSection(
  text: string,
  section: string,
  values: Record<string, string>
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const remaining = new Set(Object.keys(values));
  let inSection = false;
  let sectionFound = false;
  const out: string[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (inSection) {
        // leaving the target section: flush any keys that weren't present
        for (const key of remaining) {
          out.push(`${key}=${values[key]}`);
        }
        remaining.clear();
      }
      inSection = trimmed.slice(1, -1) === section;
      if (inSection) sectionFound = true;
      out.push(raw);
      continue;
    }
    if (inSection) {
      const eq = raw.indexOf("=");
      if (eq !== -1) {
        const key = raw.slice(0, eq).trim();
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          out.push(`${key}=${values[key]}`);
          remaining.delete(key);
          continue;
        }
      }
    }
    out.push(raw);
  }
  if (inSection && remaining.size > 0) {
    for (const key of remaining) {
      out.push(`${key}=${values[key]}`);
    }
  }
  if (!sectionFound) {
    out.push(`[${section}]`);
    for (const key of Object.keys(values)) {
      out.push(`${key}=${values[key]}`);
    }
  }
  return out.join(eol);
}

/** Build minimal basic.ini content for a profile, used only if --profile
 * on the OBS command line turns out not to create-or-select a new profile
 * by itself (fallback path — see FINDINGS.md check 2). */
export function buildMinimalProfileIni(opts: {
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
  fpsNum: number;
  fpsDen: number;
}): string {
  return [
    "[General]",
    "Name=Whatnot Studio Spike",
    "",
    "[Video]",
    `BaseCX=${opts.baseWidth}`,
    `BaseCY=${opts.baseHeight}`,
    `OutputCX=${opts.outputWidth}`,
    `OutputCY=${opts.outputHeight}`,
    `FPSNum=${opts.fpsNum}`,
    `FPSDen=${opts.fpsDen}`,
    "",
  ].join("\n");
}

/** True if `name` is a directory-safe OBS profile/collection folder name
 * (OBS slugifies the display name into this for ProfileDir/SceneCollectionFile). */
export function slugifyObsName(name: string): string {
  return name.replace(/[^A-Za-z0-9 _-]/g, "").trim();
}
