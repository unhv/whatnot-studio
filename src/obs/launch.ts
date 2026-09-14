/**
 * Product launch wrapper around spike/obs-launcher.ts's process-management
 * helpers (launchObs/closeObs/waitForPort/etc are reused as-is — this file
 * only supplies the product's own profile/collection name and launch flags
 * per the brief, instead of the spike's throwaway "Whatnot Studio Spike"
 * name and its extra probe-only flags).
 */
import { spawn } from "node:child_process";
import {
  OBS_DIR,
  OBS_EXE,
  closeObs,
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

/**
 * Launch OBS on the "Whatnot Studio" profile/collection, minimized to
 * tray, updater disabled. Deliberately does not pass the OBS CLI flag
 * that would force the stream to start on launch — see src/obs/client.ts's
 * ownership-rule comment; this app never starts the stream itself.
 */
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
