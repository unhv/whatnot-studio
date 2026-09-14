import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { readIniSection, writeIniSection } from "./lib.js";

export const OBS_DIR = "C:\\Program Files\\obs-studio\\bin\\64bit";
export const OBS_EXE = path.join(OBS_DIR, "obs64.exe");

export const SPIKE_NAME = "Whatnot Studio Spike";

const OBS_APPDATA = path.join(os.homedir(), "AppData", "Roaming", "obs-studio");
const GLOBAL_INI = path.join(OBS_APPDATA, "global.ini");
const WS_CONFIG = path.join(OBS_APPDATA, "plugin_config", "obs-websocket", "config.json");

export interface LaunchOptions {
  port: number;
  password: string;
}

export interface LaunchResult {
  pid: number;
  proc: ReturnType<typeof spawn>;
}

/** Find a free TCP port on 127.0.0.1, distinct from OBS's own default (4455). */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

export function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Snapshot of on-disk state this spike is about to touch, so it can be restored exactly. */
export interface Snapshot {
  globalIniText: string | null;
  globalIniBasic: Record<string, string>;
  wsConfigText: string | null;
}

export async function snapshotUserState(): Promise<Snapshot> {
  let globalIniText: string | null = null;
  let globalIniBasic: Record<string, string> = {};
  try {
    // global.ini is UTF-8 with a BOM; keep the BOM byte-identical on write-back.
    globalIniText = await fs.readFile(GLOBAL_INI, "utf8");
    globalIniBasic = readIniSection(globalIniText, "Basic");
  } catch {
    // global.ini may not exist yet on a fresh OBS install; nothing to restore.
  }

  let wsConfigText: string | null = null;
  try {
    wsConfigText = await fs.readFile(WS_CONFIG, "utf8");
  } catch {
    // obs-websocket may not have run yet; nothing to restore.
  }

  return { globalIniText, globalIniBasic, wsConfigText };
}

/** Restore global.ini's [Basic] Profile/SceneCollection selection and the
 * obs-websocket plugin config.json to exactly what snapshotUserState() saw. */
export async function restoreUserState(snap: Snapshot): Promise<void> {
  if (snap.globalIniText !== null) {
    const restored = writeIniSection(snap.globalIniText, "Basic", snap.globalIniBasic);
    if (restored !== snap.globalIniText) {
      await fs.writeFile(GLOBAL_INI, restored, "utf8");
    }
  }
  if (snap.wsConfigText !== null) {
    const current = await fs.readFile(WS_CONFIG, "utf8").catch(() => null);
    if (current !== snap.wsConfigText) {
      await fs.writeFile(WS_CONFIG, snap.wsConfigText, "utf8");
    }
  }
}

/**
 * obs-websocket only starts listening if its persisted config.json has
 * "server_enabled": true — the --websocket_port/--websocket_password/
 * --websocket_ipv4_only CLI flags override the VALUES but do not flip that
 * switch on their own (confirmed on this install: with server_enabled
 * false, obs-websocket logs "Module loaded" and then nothing further; no
 * "WebSocketServer::Start" line ever appears and the port never opens).
 * Call this before every launch, and restore via restoreUserState() after.
 */
export async function ensureWebsocketServerEnabled(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(WS_CONFIG, "utf8");
  } catch {
    return; // no config yet — obs-websocket will create one with defaults on first load
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.server_enabled === true) return;
  parsed.server_enabled = true;
  await fs.mkdir(path.dirname(WS_CONFIG), { recursive: true });
  await fs.writeFile(WS_CONFIG, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

/** Thrown by assertObsHidden when OBS shows a visible main window. Caught by the
 * probe's outer run loop, which must force-kill and abort the whole run. */
export class VisibleWindowError extends Error {
  constructor(pid: number) {
    super(`obs64.exe (pid ${pid}) has a visible main window`);
    this.name = "VisibleWindowError";
  }
}

/**
 * True if the obs64.exe process with this exact pid currently has a visible
 * main window (MainWindowHandle != 0). Scoped to -Id so it can never see a
 * different obs64.exe instance the user already had running.
 */
export function hasVisibleWindow(pid: number): boolean {
  let out: string;
  try {
    out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty MainWindowHandle`,
      ],
      { encoding: "utf8", windowsHide: true }
    );
  } catch {
    // process gone, or the query errored — treat as "no visible window found"
    return false;
  }
  return out.trim().length > 0;
}

/**
 * Poll for a visible main window over `windowMs` (OBS can take a moment to
 * paint before --minimize-to-tray hides it). If one ever appears, force-kill
 * this exact pid immediately and throw VisibleWindowError — callers must not
 * retry or attempt to hide it after the fact, per the brief.
 */
export async function assertObsHidden(
  pid: number,
  windowMs = 6000,
  intervalMs = 500
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    if (hasVisibleWindow(pid)) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // best-effort — the whole run is aborting regardless
      }
      throw new VisibleWindowError(pid);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Read obs-studio global.ini's [General] SysTrayEnabled/SysTrayWhenStarted,
 * which gate whether --minimize-to-tray can hide OBS at all. Report-only —
 * this spike never flips these without recording exactly what it changed. */
export async function readSysTraySettings(): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await fs.readFile(GLOBAL_INI, "utf8");
  } catch {
    return {};
  }
  const basicWindow = readIniSection(text, "BasicWindow");
  return {
    SysTrayEnabled: basicWindow.SysTrayEnabled ?? "(unset)",
    SysTrayWhenStarted: basicWindow.SysTrayWhenStarted ?? "(unset)",
  };
}

export function launchObs(opts: LaunchOptions): LaunchResult {
  const args = [
    "--profile",
    SPIKE_NAME,
    "--collection",
    SPIKE_NAME,
    "--minimize-to-tray",
    "--disable-updater",
    // OBS shows a blocking "unclean shutdown detected" Safe Mode modal on the
    // NEXT launch after any non-graceful exit (a force-kill, a crash). That
    // modal has no CLI-driven answer and stalls an unattended launch forever
    // — --disable-shutdown-check (a core obs64.exe flag, confirmed present
    // via strings on this install) skips the check entirely.
    "--disable-shutdown-check",
    "--websocket_port",
    String(opts.port),
    "--websocket_password",
    opts.password,
    "--websocket_ipv4_only",
  ];
  const proc = spawn(OBS_EXE, args, {
    cwd: OBS_DIR,
    windowsHide: false, // OBS itself owns its window; --minimize-to-tray handles visibility
    stdio: "ignore",
    detached: false,
  });
  if (!proc.pid) {
    throw new Error("failed to launch obs64.exe (no pid)");
  }
  return { pid: proc.pid, proc };
}

/** Ask OBS to close (WM_CLOSE to its window via taskkill, no /F), then force-kill
 * after a grace period if it is still alive. Never touches other obs64.exe instances
 * — it targets this exact PID only. */
export async function closeObs(pid: number, graceMs = 8000): Promise<void> {
  const isAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!isAlive()) return;

  try {
    execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // process may already be gone, or refused a graceful close — fall through to force-kill
  }

  const start = Date.now();
  while (isAlive() && Date.now() - start < graceMs) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (isAlive()) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best-effort
    }
  }
}

export async function waitForPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", (e) => {
        lastErr = e;
        resolve(false);
      });
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${host}:${port} (last error: ${String(lastErr)})`);
}
