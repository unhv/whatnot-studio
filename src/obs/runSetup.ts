/**
 * Wires `runFirstRunSetup` (src/obs/firstRun.ts) to the app's real IPC
 * bridge (electron/preload.ts's `window.whatnotStudio`) and a real
 * `ObsClient`. Kept separate from firstRun.ts so that file stays free of
 * any IPC/Electron shape, and separate from the renderer component so this
 * whole adapter is unit-testable with a fake bridge (no jsdom, no
 * Electron) -- previously this wiring did not exist at all; the Setup
 * screen's Continue button only flipped `screen` in the store.
 */
import { runFirstRunSetup, type FirstRunDeps, type FirstRunFs, type FirstRunResult } from "./firstRun.js";
import type { ObsClient } from "./client.js";
import { PROFILE_NAME } from "../shared/types.js";

/** The minimal slice of `window.whatnotStudio` this module needs -- kept
 * narrow and structural (not importing the preload's concrete type) so a
 * test can pass a plain fake object without touching Electron at all. */
export interface FirstRunBridge {
  firstRunPaths(profileName?: string): Promise<{ profileIniPath: string; sceneCollectionJsonPath: string }>;
  writeFirstRunFiles(args: {
    profileIniPath: string;
    sceneCollectionJsonPath: string;
    profileIni: string;
    sceneCollectionJson: string;
  }): Promise<void>;
  launchObs(opts: { port: number; password: string; profileName?: string }): Promise<{ pid: number }>;
  closeObs(pid: number): Promise<void>;
}

function makeBatchedFs(
  bridge: FirstRunBridge,
  paths: { profileIniPath: string; sceneCollectionJsonPath: string }
): FirstRunFs {
  // electron/main.ts's firstRun:writeFiles IPC handler writes both files (and
  // their mkdir -p) in a single call, but runFirstRunSetup calls
  // mkdir/writeFile once per file in sequence -- buffer both and fire once
  // both contents are known.
  let profileIni: string | null = null;
  let sceneCollectionJson: string | null = null;

  return {
    async mkdir() {
      // no-op here: electron/main.ts's writeFiles handler does its own
      // `fs.mkdir(..., { recursive: true })` for both paths.
    },
    async writeFile(filePath: string, contents: string) {
      if (filePath === paths.profileIniPath) profileIni = contents;
      else if (filePath === paths.sceneCollectionJsonPath) sceneCollectionJson = contents;

      if (profileIni !== null && sceneCollectionJson !== null) {
        await bridge.writeFirstRunFiles({
          profileIniPath: paths.profileIniPath,
          sceneCollectionJsonPath: paths.sceneCollectionJsonPath,
          profileIni,
          sceneCollectionJson,
        });
      }
    },
    dirname(filePath: string) {
      return filePath.split(/[\\/]/).slice(0, -1).join("/");
    },
  };
}

export interface RunAppFirstRunOptions {
  bridge: FirstRunBridge;
  port: number;
  password: string;
  profileName?: string;
  /** Constructs a fresh ObsClient each time OBS is (re)connected to. Real
   * callers pass `() => new RealObsClient()`; tests pass a fake factory. */
  makeObsClient(): ObsClient;
}

/** Run the full first-run flow against the real app's IPC bridge. */
export async function runAppFirstRun(opts: RunAppFirstRunOptions): Promise<FirstRunResult> {
  const profileName = opts.profileName ?? PROFILE_NAME;
  const paths = await opts.bridge.firstRunPaths(profileName);
  const fs = makeBatchedFs(opts.bridge, paths);

  const deps: FirstRunDeps = {
    paths,
    fs,
    profileName,
    launch: () => opts.bridge.launchObs({ port: opts.port, password: opts.password, profileName }),
    connect: async () => {
      const client = opts.makeObsClient();
      await client.connect(`ws://127.0.0.1:${opts.port}`, opts.password);
      return client;
    },
    closeObs: (pid) => opts.bridge.closeObs(pid),
  };

  return runFirstRunSetup(deps);
}
