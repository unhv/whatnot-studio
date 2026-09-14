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
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { closeObs, launchObsForProductAsync, waitForPort } from "../src/obs/launch.js";
import { profileDirName, sceneCollectionFileName } from "../src/obs/firstRun.js";
import { PROFILE_NAME } from "../src/shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OBS_APPDATA = path.join(os.homedir(), "AppData", "Roaming", "obs-studio");

function firstRunPaths(profileName: string = PROFILE_NAME) {
  const dir = profileDirName(profileName);
  const file = sceneCollectionFileName(profileName);
  return {
    profileIniPath: path.join(OBS_APPDATA, "basic", "profiles", dir, "basic.ini"),
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
}

app.whenReady().then(() => {
  createWindow();
  registerHotkeys();

  ipcMain.handle("firstRun:paths", (_event, profileName?: string) => firstRunPaths(profileName));

  ipcMain.handle(
    "firstRun:writeFiles",
    async (_event, args: { profileIniPath: string; sceneCollectionJsonPath: string; profileIni: string; sceneCollectionJson: string }) => {
      await fs.mkdir(path.dirname(args.profileIniPath), { recursive: true });
      await fs.writeFile(args.profileIniPath, args.profileIni, "utf8");
      await fs.mkdir(path.dirname(args.sceneCollectionJsonPath), { recursive: true });
      await fs.writeFile(args.sceneCollectionJsonPath, args.sceneCollectionJson, "utf8");
    }
  );

  ipcMain.handle("obs:launch", async (_event, opts: { port: number; password: string; profileName?: string }) => {
    const { pid } = await launchObsForProductAsync(opts);
    await waitForPort(opts.port);
    return { pid };
  });

  ipcMain.handle("obs:close", async (_event, pid: number) => {
    await closeObs(pid);
  });

  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle("shell:openInChrome", async (_event, url: string) => {
    await openInChrome(url);
  });

  ipcMain.handle("clipboard:write", (_event, text: string) => {
    clipboard.writeText(text);
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
