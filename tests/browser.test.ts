import { describe, expect, it } from "vitest";
import { chromiumCandidatePaths, resolveBrowserPath, type BrowserEnv } from "../electron/browser.js";

const env: BrowserEnv = {
  "PROGRAMFILES(X86)": "D:\\x86",
  PROGRAMFILES: "D:\\pf",
  LOCALAPPDATA: "D:\\local",
};

const candidates = chromiumCandidatePaths(env);
const [edgeX86, edgePf, edgeLocal, chromePf, chromeX86, chromeLocal] = candidates;

function existsSet(present: string[]) {
  const set = new Set(present);
  return async (filePath: string) => set.has(filePath);
}

describe("resolveBrowserPath", () => {
  it("returns the Edge path when both Edge and Chrome exist", async () => {
    const found = await resolveBrowserPath(existsSet([edgeX86, edgePf, chromePf, chromeX86]), env);
    expect(found).toBe(edgeX86);
    expect(found).not.toBe(chromePf);
  });

  it("returns Chrome when only Chrome exists", async () => {
    const path = await resolveBrowserPath(existsSet([chromePf, chromeX86, chromeLocal]), env);
    expect(path).toBe(chromePf);
    expect(path).not.toMatch(/msedge\.exe$/);
  });

  it("returns null when neither Edge nor Chrome exists so the caller can openExternal", async () => {
    expect(await resolveBrowserPath(existsSet([]), env)).toBeNull();
  });

  it("probes Edge candidates in documented order: x86, Program Files, LocalAppData", async () => {
    const probed: string[] = [];
    const exists = async (filePath: string) => {
      probed.push(filePath);
      return filePath === edgeLocal;
    };
    const found = await resolveBrowserPath(exists, env);
    expect(found).toBe(edgeLocal);
    expect(probed).toEqual([edgeX86, edgePf, edgeLocal]);
    expect(edgeX86).toBe("D:\\x86\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(edgePf).toBe("D:\\pf\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(edgeLocal).toBe("D:\\local\\Microsoft\\Edge\\Application\\msedge.exe");
  });
});
