/**
 * First-run setup: create the "Whatnot Studio" profile + scene collection
 * on disk before OBS ever launches, then verify over the websocket that
 * OBS actually came up on them. A mismatch is a stop condition — this app
 * must never continue and silently edit whatever profile/collection the
 * user's OBS happened to already be on.
 *
 * `buildMinimalProfileIni`/`slugifyObsName` (spike/lib.ts) are reused as-is;
 * this file only composes them for the product's profile name instead of
 * the spike's.
 *
 * KNOWN GAP, see HANDOVER.md: the scene-collection JSON built by
 * `buildSceneCollectionSkeleton` below is a best-effort minimal skeleton
 * modelled on the public obs-studio scene collection format. It has never
 * been loaded by a real OBS — that is exactly the kind of check this task
 * is forbidden from doing. The supervised run must confirm OBS accepts it
 * before this path is trusted; if it doesn't, the fallback is to launch
 * OBS on its existing default collection once and use `CreateSceneCollection`
 * over the websocket instead of a hand-written file.
 */
import { buildMinimalProfileIni, slugifyObsName, writeIniSection } from "../../spike/lib.js";
import type { ObsClient } from "./client.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, PROFILE_NAME } from "../shared/types.js";

export interface ProfileListResult {
  profiles: string[];
  currentProfileName: string;
}

export interface SceneCollectionListResult {
  sceneCollections: string[];
  currentSceneCollectionName: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * The mismatch stop condition. Pure — takes exactly what
 * `GetProfileList`/`GetSceneCollectionList` return and the name we expect
 * both to report as current. Never "fixes" a mismatch; only reports it.
 */
export function verifyProfileAndCollection(
  profileList: ProfileListResult,
  collectionList: SceneCollectionListResult,
  expectedName: string
): VerifyResult {
  if (profileList.currentProfileName !== expectedName) {
    return {
      ok: false,
      reason:
        `OBS came up on profile "${profileList.currentProfileName}", not "${expectedName}". ` +
        `Refusing to continue — continuing would mean editing a profile that isn't ours.`,
    };
  }
  if (collectionList.currentSceneCollectionName !== expectedName) {
    return {
      ok: false,
      reason:
        `OBS came up on scene collection "${collectionList.currentSceneCollectionName}", not "${expectedName}". ` +
        `Refusing to continue — continuing would mean editing a scene collection that isn't ours.`,
    };
  }
  return { ok: true };
}

/** Build basic.ini content for the product's profile, reusing the tested
 * spike helper for the [Video] section and overriding [General].Name on
 * top of it via writeIniSection rather than duplicating that logic. */
export function buildFirstRunProfileIni(profileName: string = PROFILE_NAME): string {
  const base = buildMinimalProfileIni({
    baseWidth: CANVAS_WIDTH,
    baseHeight: CANVAS_HEIGHT,
    outputWidth: CANVAS_WIDTH,
    outputHeight: CANVAS_HEIGHT,
    fpsNum: 30,
    fpsDen: 1,
  });
  return writeIniSection(base, "General", { Name: profileName });
}

/** Best-effort minimal scene collection JSON skeleton — see the file-level
 * gap note above. One placeholder scene ("Scene") so OBS has a valid
 * current_scene; the real four scenes are created idempotently afterwards
 * by src/obs/applyPlan.ts over the websocket. */
export function buildSceneCollectionSkeleton(name: string): Record<string, unknown> {
  return {
    current_scene: "Scene",
    current_program_scene: "Scene",
    current_transition: "Fade",
    transition_duration: 300,
    scene_order: [{ name: "Scene" }],
    name,
    sources: [
      {
        id: "scene",
        name: "Scene",
        settings: { items: [] },
        mixers: 0,
        sync: 0,
        flags: 0,
        volume: 1,
        balance: 0.5,
        enabled: true,
        muted: false,
        push_to_mute: false,
        push_to_talk: false,
      },
    ],
    quick_transitions: [],
    transitions: [],
    saved_projectors: [],
    modules: {},
  };
}

export function profileDirName(profileName: string = PROFILE_NAME): string {
  return slugifyObsName(profileName);
}

export function sceneCollectionFileName(profileName: string = PROFILE_NAME): string {
  return slugifyObsName(profileName);
}

export interface FirstRunPaths {
  profileIniPath: string;
  sceneCollectionJsonPath: string;
}

export interface FirstRunFs {
  mkdir(dirPath: string): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  dirname(filePath: string): string;
}

export interface FirstRunResult {
  ok: boolean;
  reason?: string;
  pid?: number;
  /** Plain-language warning, set when OBS reports a 32.x version -- Whatnot's
   * Show Tools page warns every 32.x.x build needs the bitrate capped
   * manually or shows fail to start (measured 2026-09-15,
   * whatnot-show-tools-measured.md). Not testable live on this machine
   * (31.1.2) -- only the version read + warning text is implemented. */
  versionWarning?: string;
}

/** Pure — takes obs-websocket's own `obsVersion` string and returns a
 * warning message for any 32.x.x build, or undefined otherwise. */
export function checkObsVersionWarning(obsVersion: string): string | undefined {
  if (/^32\./.test(obsVersion)) {
    return (
      `OBS ${obsVersion} detected. Whatnot's Show Tools warns that all 32.x.x OBS versions ` +
      `need the stream bitrate capped manually or the show may fail to start.`
    );
  }
  return undefined;
}

/**
 * OWNERSHIP RULE EXCEPTION — documented and deliberate (HQ, 2026-09-15,
 * whatnot-show-tools-measured.md). Whatnot's Show Tools page cannot apply
 * four Output settings itself and instructs the seller to set them
 * manually: Bitrate max 3500 Kbps (range 2500-3500), Keyframe Interval 2s,
 * Rate Control CBR, Tune zerolatency. Since Whatnot's page never writes
 * these itself, writing them here creates no conflict with the file-level
 * ownership rule — `SetStreamServiceSettings` remains untouched forever,
 * and so does everything else in Output/Stream.
 *
 * MEASURED 2026-09-15 live against a real OBS 31.1.2: `SimpleOutput/VBitrate`
 * is a portable ini parameter, settable via `SetProfileParameter` and
 * confirmed to apply regardless of which streaming encoder is selected
 * (confirmed read-back: 2500 -> 3500). Keyframe Interval / Rate Control /
 * Tune are properties of the x264 encoder specifically (OBS's NVENC/AMF/
 * QuickSync encoders use different property names, e.g. NVENC has no
 * "tune" concept at all) — they can only be safely written when the
 * seller's own `SimpleOutput/StreamEncoder` is already x264, via the
 * `x264Settings` custom-options ini field (confirmed writable, format
 * `key=value key=value ...`). On this session's test machine the default
 * `StreamEncoder` was `nvenc`, not `x264` — the x264 path below was
 * exercised for the write only (confirmed the field accepts and persists
 * the string), not end-to-end against a real x264 stream, and is not
 * forced onto sellers using a different encoder. See HANDOVER.md.
 */
export async function applyWhatnotEncoderSettings(obs: ObsClient): Promise<void> {
  await obs.call("SetProfileParameter", {
    parameterCategory: "SimpleOutput",
    parameterName: "VBitrate",
    parameterValue: "3500",
  });

  const streamEncoder = await obs.call<{ parameterValue: string | null }>("GetProfileParameter", {
    parameterCategory: "SimpleOutput",
    parameterName: "StreamEncoder",
  });

  if (streamEncoder.parameterValue === "x264" || streamEncoder.parameterValue === "obs_x264") {
    await obs.call("SetProfileParameter", {
      parameterCategory: "SimpleOutput",
      parameterName: "UseAdvanced",
      parameterValue: "true",
    });
    await obs.call("SetProfileParameter", {
      parameterCategory: "SimpleOutput",
      parameterName: "x264Settings",
      parameterValue: "keyint=2 tune=zerolatency",
    });
  }
  // Rate Control CBR: OBS's Simple output mode always streams at the fixed
  // VBitrate set above (no variable-bitrate option exists in Simple mode),
  // which is CBR in effect — no separate write is needed or attempted.
}

export interface FirstRunDeps {
  paths: FirstRunPaths;
  fs: FirstRunFs;
  /** Launch OBS on the freshly-written profile/collection. */
  launch(): Promise<{ pid: number }>;
  /** Connect a fresh ObsClient to the just-launched (or just-restarted) OBS. */
  connect(): Promise<ObsClient>;
  /** Gracefully close OBS at this pid (never force-kill — see FINDINGS.md). */
  closeObs(pid: number): Promise<void>;
  profileName?: string;
}

/**
 * The full first-run flow: write files, launch, verify (stop on mismatch),
 * set the canvas, restart, done. Every side effect is injected, so this is
 * unit-testable end to end with fakes — no OBS is ever launched by a test.
 */
export async function runFirstRunSetup(deps: FirstRunDeps): Promise<FirstRunResult> {
  const profileName = deps.profileName ?? PROFILE_NAME;

  await deps.fs.mkdir(deps.fs.dirname(deps.paths.profileIniPath));
  await deps.fs.writeFile(deps.paths.profileIniPath, buildFirstRunProfileIni(profileName));

  await deps.fs.mkdir(deps.fs.dirname(deps.paths.sceneCollectionJsonPath));
  await deps.fs.writeFile(
    deps.paths.sceneCollectionJsonPath,
    JSON.stringify(buildSceneCollectionSkeleton(profileName), null, 2)
  );

  const { pid } = await deps.launch();
  const obs = await deps.connect();

  const profileList = await obs.call<ProfileListResult>("GetProfileList");
  const collectionList = await obs.call<SceneCollectionListResult>("GetSceneCollectionList");
  const verify = verifyProfileAndCollection(profileList, collectionList, profileName);

  if (!verify.ok) {
    await obs.disconnect();
    return { ok: false, reason: verify.reason, pid };
  }

  const version = await obs.call<{ obsVersion: string }>("GetVersion");
  const versionWarning = checkObsVersionWarning(version.obsVersion);

  await obs.call("SetVideoSettings", {
    baseWidth: CANVAS_WIDTH,
    baseHeight: CANVAS_HEIGHT,
    outputWidth: CANVAS_WIDTH,
    outputHeight: CANVAS_HEIGHT,
    fpsNumerator: 30,
    fpsDenominator: 1,
  });
  await applyWhatnotEncoderSettings(obs);
  await obs.disconnect();

  // The canvas setting only takes effect for Whatnot's health check after a
  // full restart (FINDINGS.md check 3) — this is a one-time cost.
  await deps.closeObs(pid);
  const relaunched = await deps.launch();
  const obs2 = await deps.connect();
  await obs2.disconnect();

  return { ok: true, pid: relaunched.pid, versionWarning };
}
