/**
 * Electron main process. Owns exactly three things Node access is required
 * for: launching/closing the OBS process, writing the first-run profile/
 * scene-collection files, and global hotkeys (keyboard focus lives in the
 * seller's browser, so F1-F5 must be global, not window-scoped).
 *
 * The ObsClient itself (the actual websocket connection to OBS) lives in
 * the renderer — obs-websocket-js works directly over the browser
 * WebSocket API Electron's renderer already has, so there is no need to
 * proxy every OBS request through IPC.
 *
 * OWNERSHIP RULE: this file must never write the OBS stream service
 * config or pass the CLI flag that forces the stream to start on launch.
 * See src/obs/client.ts for the full rule.
 */
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { closeObs, launchObsForProductAsync, waitForPort } from "../src/obs/launch.js";
import { profileDirName, sceneCollectionFileName } from "../src/obs/firstRun.js";
import { PROFILE_NAME } from "../src/shared/types.js";
import { errorCodeFromUnknown, obsWebsocketConfigFromRead } from "../src/obs/obsConfig.js";
import { durationMsFromBytes } from "../src/clips/duration.js";
import { isSupportedClipExtension, uniqueClipFileName } from "../src/clips/scan.js";
import {
  readShowStoreFile,
  readShowStoreFileSync,
  showStorePath,
  writeShowStoreFile,
} from "./configStore.js";
import { runUploadProbe } from "./uploadProbe.js";
import {
  createMuteHotkeyController,
  DEFAULT_MUTE_ACCELERATOR,
  muteHotkeyFromStored,
} from "../src/audio/muteHotkey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OBS_APPDATA = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "obs-studio"
);
const OBS_WEBSOCKET_CONFIG = path.join(OBS_APPDATA, "plugin_config", "obs-websocket", "config.json");

function firstRunPaths(profileName: string = PROFILE_NAME) {
  const dir = profileDirName(profileName);
  const file = sceneCollectionFileName(profileName);
  const profileDir = path.join(OBS_APPDATA, "basic", "profiles", dir);
  return {
    profileIniPath: path.join(profileDir, "basic.ini"),
    streamEncoderJsonPath: path.join(profileDir, "streamEncoder.json"),
    sceneCollectionJsonPath: path.join(OBS_APPDATA, "basic", "scenes", `${file}.json`),
  };
}

// Whatnot's Show Tools page requires Chrome specifically ("Other Chromium
// based browsers may work but are not guaranteed" -- measured 2026-09-15,
// whatnot-show-tools-measured.md). Try the usual Windows install locations
// before falling back to the OS default browser.
const CHROME_CANDIDATE_PATHS = [
  path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(
    process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe"
  ),
  path.join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
];

async function resolveChromePath(): Promise<string | null> {
  for (const candidate of CHROME_CANDIDATE_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not at this location, try the next
    }
  }
  return null;
}

/** Open a URL in Chrome specifically, falling back to the OS default
 * browser (via shell.openExternal) if Chrome's path can't be resolved.
 * The fallback case is recorded in FINDINGS.md rather than assumed away. */
async function openInChrome(url: string): Promise<void> {
  const chromePath = await resolveChromePath();
  if (!chromePath) {
    await shell.openExternal(url);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    execFile(chromePath, [url], (err) => (err ? reject(err) : resolve()));
  });
}

let mainWindow: BrowserWindow | null = null;

const muteHotkeys = createMuteHotkeyController({
  register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
  unregister: (accelerator) => globalShortcut.unregister(accelerator),
  sendToggle: () => {
    mainWindow?.webContents.send("mute-hotkey");
  },
});

function muteHotkeyFile(): string {
  return path.join(app.getPath("userData"), "mute-hotkey.json");
}

function loadMuteAccelerator(): string {
  try {
    const raw = JSON.parse(readFileSync(muteHotkeyFile(), "utf8")) as unknown;
    return muteHotkeyFromStored(raw);
  } catch {
    return DEFAULT_MUTE_ACCELERATOR;
  }
}

function persistMuteAccelerator(accelerator: string): void {
  try {
    writeFileSync(muteHotkeyFile(), JSON.stringify({ accelerator }), "utf8");
  } catch {
    // settings still live in memory this session
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 900,
    minWidth: 480,
    backgroundColor: "#0b0b0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    muteHotkeys.releaseAll();
    mainWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

const HOTKEYS = ["F1", "F2", "F3", "F4", "F5"] as const;

function registerHotkeys(): void {
  for (const key of HOTKEYS) {
    globalShortcut.register(key, () => {
      mainWindow?.webContents.send("hotkey", key);
    });
  }
  muteHotkeys.set(loadMuteAccelerator());
}

function unregisterSceneHotkeys(): void {
  for (const key of HOTKEYS) {
    globalShortcut.unregister(key);
  }
}

app.whenReady().then(() => {
  // Show-store IPC must be up before the window loads: the renderer
  // rehydrates synchronously on first paint via sendSync.
  const showsFile = () => showStorePath(app.getPath("userData"));

  ipcMain.on("shows:loadSync", (event) => {
    event.returnValue = readShowStoreFileSync(showsFile());
  });

  ipcMain.handle("shows:load", async () => readShowStoreFile(showsFile()));

  ipcMain.handle("shows:save", async (_event, payload: unknown) => {
    await writeShowStoreFile(showsFile(), payload);
  });

  ipcMain.on("obs:websocketConfigSync", (event) => {
    try {
      const text = readFileSync(OBS_WEBSOCKET_CONFIG, "utf8");
      event.returnValue = obsWebsocketConfigFromRead({ ok: true, text });
    } catch (err) {
      event.returnValue = obsWebsocketConfigFromRead({ ok: false, code: errorCodeFromUnknown(err) });
    }
  });

  createWindow();
  registerHotkeys();

  ipcMain.handle("firstRun:paths", (_event, profileName?: string) => firstRunPaths(profileName));

  ipcMain.handle(
    "firstRun:writeFiles",
    async (
      _event,
      args: {
        profileIniPath?: string;
        sceneCollectionJsonPath?: string;
        profileIni?: string;
        sceneCollectionJson?: string;
        streamEncoderJsonPath?: string;
        streamEncoderJson?: string;
      }
    ) => {
      if (args.profileIniPath && args.profileIni != null) {
        await fs.mkdir(path.dirname(args.profileIniPath), { recursive: true });
        await fs.writeFile(args.profileIniPath, args.profileIni, "utf8");
      }
      if (args.sceneCollectionJsonPath && args.sceneCollectionJson != null) {
        await fs.mkdir(path.dirname(args.sceneCollectionJsonPath), { recursive: true });
        await fs.writeFile(args.sceneCollectionJsonPath, args.sceneCollectionJson, "utf8");
      }
      if (args.streamEncoderJsonPath && args.streamEncoderJson != null) {
        await fs.mkdir(path.dirname(args.streamEncoderJsonPath), { recursive: true });
        await fs.writeFile(args.streamEncoderJsonPath, args.streamEncoderJson, "utf8");
      }
    }
  );

  ipcMain.handle("obs:launch", async (_event, opts: { port: number; password: string; profileName?: string }) => {
    const launched = await launchObsForProductAsync(opts);
    if (!launched.reused) {
      await waitForPort(opts.port);
    }
    return { pid: launched.pid, reused: launched.reused };
  });

  ipcMain.handle("obs:close", async (_event, pid: number) => {
    await closeObs(pid);
  });

  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    await shell.openExternal(url);
  });

  // Clips folder lives under userData. The renderer is sandboxed and cannot
  // import node:fs, so scan/exists/mkdir go through here.
  const clipsFolder = () => path.join(app.getPath("userData"), "clips");

  ipcMain.handle("clips:dir", async () => {
    const dir = clipsFolder();
    await fs.mkdir(dir, { recursive: true });
    return dir;
  });

  ipcMain.handle("clips:mkdir", async (_event, dir: string) => {
    if (typeof dir !== "string" || dir === "") return;
    await fs.mkdir(dir, { recursive: true });
  });

  ipcMain.handle("clips:readdir", async (_event, dir: string) => {
    if (typeof dir !== "string" || dir === "") return [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
      return [];
    }
  });

  ipcMain.handle("clips:exists", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || filePath === "") return false;
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  });

  function isInsideClips(filePath: string): boolean {
    const root = path.resolve(clipsFolder());
    const resolved = path.resolve(filePath);
    const rel = path.relative(root, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  ipcMain.handle("clips:durationMs", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || filePath === "" || !isInsideClips(filePath)) return null;
    try {
      const buf = await fs.readFile(filePath);
      return durationMsFromBytes(buf, path.basename(filePath));
    } catch {
      return null;
    }
  });

  ipcMain.handle("clips:import", async (_event, sourcePath: string) => {
    if (typeof sourcePath !== "string" || sourcePath === "") return null;
    const resolved = path.resolve(sourcePath);
    const base = path.basename(resolved);
    if (!isSupportedClipExtension(base)) return null;
    const dir = clipsFolder();
    await fs.mkdir(dir, { recursive: true });
    if (isInsideClips(resolved)) return resolved;
    try {
      const names = await fs.readdir(dir);
      const destName = uniqueClipFileName(names, base);
      const dest = path.join(dir, destName);
      await fs.copyFile(resolved, dest);
      return dest;
    } catch {
      return null;
    }
  });

  ipcMain.handle("clips:write", async (_event, fileName: string, data: ArrayBuffer | Uint8Array) => {
    if (typeof fileName !== "string" || fileName === "") return null;
    const base = path.basename(fileName);
    if (!isSupportedClipExtension(base) || !data) return null;
    const dir = clipsFolder();
    await fs.mkdir(dir, { recursive: true });
    try {
      const names = await fs.readdir(dir);
      const destName = uniqueClipFileName(names, base);
      const dest = path.join(dir, destName);
      const buf = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
      await fs.writeFile(dest, buf);
      return dest;
    } catch {
      return null;
    }
  });

  ipcMain.handle("shell:openInChrome", async (_event, url: string) => {
    await openInChrome(url);
  });

  ipcMain.handle("clipboard:write", (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle("quality:probeUpload", async () => runUploadProbe());

  ipcMain.handle("muteHotkey:get", async () => {
    const status = muteHotkeys.get();
    return { accelerator: status.accelerator, registered: status.registered };
  });

  ipcMain.handle("muteHotkey:set", async (_event, accelerator: unknown) => {
    const next = muteHotkeyFromStored(accelerator);
    const status = muteHotkeys.set(next);
    persistMuteAccelerator(status.accelerator);
    return { accelerator: status.accelerator, registered: status.registered };
  });

  // Always re-read from disk. The seller's Try again depends on picking up
  // a change they just made in OBS's WebSocket Server Settings.
  ipcMain.handle("obs:websocketConfig", async () => {
    try {
      const text = await fs.readFile(OBS_WEBSOCKET_CONFIG, "utf8");
      return obsWebsocketConfigFromRead({ ok: true, text });
    } catch (err) {
      return obsWebsocketConfigFromRead({ ok: false, code: errorCodeFromUnknown(err) });
    }
  });
});

app.on("will-quit", () => {
  muteHotkeys.releaseAll();
  unregisterSceneHotkeys();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
