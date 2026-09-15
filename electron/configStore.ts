/**
 * JSON file in userData — the electron-store slot for named shows.
 * package.json is frozen on this brief, so this is the store rather than
 * the electron-store package. Callers must pass a payload that already
 * went through persistableShowConfig; this layer also blanks any
 * obsPassword it sees so a secret never lands as plain JSON.
 */
import { promises as fs } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

export const SHOW_STORE_FILENAME = "shows.json";

export function showStorePath(userDataDir: string): string {
  return path.join(userDataDir, SHOW_STORE_FILENAME);
}

function blankObsPasswords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankObsPasswords);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "obsPassword" ? "" : blankObsPasswords(child);
    }
    return out;
  }
  return value;
}

export function payloadForDisk(raw: unknown): string {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const json = JSON.stringify(blankObsPasswords(data), null, 2);
  if (typeof json !== "string") {
    throw new Error("show store payload is not JSON");
  }
  return json;
}

export async function readShowStoreFile(filePath: string): Promise<unknown> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    if (text.trim() === "") return { version: 1, lastUsedName: null, shows: [] };
    return JSON.parse(text) as unknown;
  } catch {
    return { version: 1, lastUsedName: null, shows: [] };
  }
}

export function readShowStoreFileSync(filePath: string): unknown {
  try {
    const text = readFileSync(filePath, "utf8");
    if (text.trim() === "") return { version: 1, lastUsedName: null, shows: [] };
    return JSON.parse(text) as unknown;
  } catch {
    return { version: 1, lastUsedName: null, shows: [] };
  }
}

export async function writeShowStoreFile(filePath: string, raw: unknown): Promise<void> {
  const json = payloadForDisk(raw);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, json, "utf8");
}

export function writeShowStoreFileSync(filePath: string, raw: unknown): void {
  const json = payloadForDisk(raw);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, json, "utf8");
}
