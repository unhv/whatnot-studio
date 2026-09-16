/**
 * Resolve a Chromium browser for Whatnot Show Tools.
 *
 * Whatnot's warning is about Chromium, not Chrome specifically. Edge is
 * tried first because that is where the seller's signed-in Whatnot
 * session lives; Chrome is the fallback; null means the caller should
 * use shell.openExternal.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type FileExists = (filePath: string) => Promise<boolean>;

export type BrowserEnv = {
  PROGRAMFILES?: string;
  "PROGRAMFILES(X86)"?: string;
  LOCALAPPDATA?: string;
};

async function defaultExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Edge (x86, then 64-bit, then LocalAppData), then Chrome in the same three roots as before. */
export function chromiumCandidatePaths(env: BrowserEnv = process.env): string[] {
  const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const programFiles = env.PROGRAMFILES ?? "C:\\Program Files";
  const localAppData = env.LOCALAPPDATA ?? "";
  return [
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ];
}

export async function resolveBrowserPath(
  exists: FileExists = defaultExists,
  env: BrowserEnv = process.env
): Promise<string | null> {
  for (const candidate of chromiumCandidatePaths(env)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}
