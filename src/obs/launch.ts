/**
 * Product launch wrapper around spike/obs-launcher.ts's process-management
 * helpers (launchObs/closeObs/waitForPort/etc are reused as-is — this file
 * only supplies the product's own profile/collection name and launch flags
 * per the brief, instead of the spike's throwaway "Whatnot Studio Spike"
 * name and its extra probe-only flags).
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import {
  OBS_DIR,
  OBS_EXE,
  closeObs,
  ensureWebsocketServerEnabled,
  waitForPort,
  type LaunchResult,
} from "../../spike/obs-launcher.js";
import { PROFILE_NAME } from "../shared/types.js";

export { closeObs, waitForPort, OBS_DIR, OBS_EXE };

export interface ProductLaunchOptions {
  port: number;
  password: string;
  profileName?: string;
}

export interface ProductLaunchResult {
  pid: number;
  /** True when 127.0.0.1:port was already accepting connections; nothing was spawned. */
  reused: boolean;
}

export interface LaunchProbe {
  isPortOpen?(port: number): Promise<boolean>;
}

/** One TCP connect to 127.0.0.1. Used to refuse a second obs64 on the seller's port. */
export function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Launch OBS on the "Whatnot Studio" profile/collection, minimized to
 * tray, updater disabled. Deliberately does not pass the OBS CLI flag
 * that would force the stream to start on launch — see src/obs/client.ts's
 * ownership-rule comment; this app never starts the stream itself.
 *
 * If the websocket port is already listening, this returns without
 * spawning — two obs64 processes cannot both own the same port, and
 * waitForPort would succeed on the instance that is already up.
 *
 * MEASURED 2026-09-15 (FINDINGS.md, supervised run): obs-websocket's
 * persisted plugin_config/obs-websocket/config.json can have
 * "server_enabled": false, and --websocket_port/--websocket_password/
 * --websocket_ipv4_only only override the VALUES inside that config — they
 * do not flip server_enabled to true. Without this call the websocket never
 * opens and every first run times out waiting for the port, silently.
 */
export async function launchObsForProductAsync(
  opts: ProductLaunchOptions,
  probe: LaunchProbe = {}
): Promise<ProductLaunchResult> {
  const portOpen = probe.isPortOpen ?? isPortOpen;
  if (await portOpen(opts.port)) {
    return { pid: 0, reused: true };
  }
  await ensureWebsocketServerEnabled();
  const launched = launchObsForProduct(opts);
  return { pid: launched.pid, reused: false };
}

export function launchObsForProduct(opts: ProductLaunchOptions): LaunchResult {
  const profileName = opts.profileName ?? PROFILE_NAME;
  const args = [
    "--profile",
    profileName,
    "--collection",
    profileName,
    "--minimize-to-tray",
    "--disable-updater",
    "--websocket_port",
    String(opts.port),
    "--websocket_password",
    opts.password,
    "--websocket_ipv4_only",
  ];
  const proc = spawn(OBS_EXE, args, {
    cwd: OBS_DIR,
    windowsHide: false, // OBS owns its own window; --minimize-to-tray handles visibility
    stdio: "ignore",
    detached: false,
  });
  if (!proc.pid) {
    throw new Error("failed to launch obs64.exe (no pid)");
  }
  return { pid: proc.pid, proc };
}
