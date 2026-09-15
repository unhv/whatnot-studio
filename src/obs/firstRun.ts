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
  /** Sibling of basic.ini. Advanced mode reads this, not AdvOut/VBitrate. */
  streamEncoderJsonPath?: string;
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
  /** Set when the streaming encoder is not x264, so keyframe interval and
   * zerolatency tune cannot be written. Bitrate is still capped. */
  encoderWarning?: string;
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

/** Matches `SetVideoSettings` / `buildFirstRunProfileIni` in this file. */
const DEFAULT_CANVAS_FPS = 30;
const KEYFRAME_INTERVAL_SEC = 2;
const WHATNOT_VBITRATE = "3500";

export interface EncoderSettingsResult {
  encoderWarning?: string;
}

/** x264 `keyint` is measured in frames, not seconds. Whatnot asks for a
 * 2-second keyframe interval, so keyint = 2 * fps. */
export function keyintForIntervalSec(
  fpsNumerator: number,
  fpsDenominator: number,
  intervalSec: number = KEYFRAME_INTERVAL_SEC
): number {
  const den = fpsDenominator > 0 ? fpsDenominator : 1;
  const num = fpsNumerator > 0 ? fpsNumerator : DEFAULT_CANVAS_FPS;
  const frames = Math.round((intervalSec * num) / den);
  return frames > 0 ? frames : intervalSec * DEFAULT_CANVAS_FPS;
}

function isX264Encoder(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "x264" || v === "obs_x264" || v === "x264_lowcpu";
}

/** Advanced output reads this file, not `[AdvOut] VBitrate` / `x264Settings`. */
export function buildWhatnotStreamEncoderJson(): {
  bitrate: number;
  keyint_sec: number;
  rate_control: string;
  tune: string;
} {
  return {
    bitrate: Number(WHATNOT_VBITRATE),
    keyint_sec: KEYFRAME_INTERVAL_SEC,
    rate_control: "CBR",
    tune: "zerolatency",
  };
}

export function streamEncoderJsonPathFromProfileIni(profileIniPath: string): string {
  return profileIniPath.replace(/basic\.ini$/i, "streamEncoder.json");
}

async function readProfileParam(obs: ObsClient, category: string, name: string): Promise<string | null> {
  const result = await obs.call<{ parameterValue: string | null }>("GetProfileParameter", {
    parameterCategory: category,
    parameterName: name,
  });
  return result.parameterValue ?? null;
}

async function setProfileParam(obs: ObsClient, category: string, name: string, value: string): Promise<void> {
  await obs.call("SetProfileParameter", {
    parameterCategory: category,
    parameterName: name,
    parameterValue: value,
  });
}

async function readCategoryEncoder(obs: ObsClient, category: string): Promise<string | null> {
  // Simple stores the id on StreamEncoder; Advanced stores it on Encoder.
  const names = category === "AdvOut" ? ["Encoder", "StreamEncoder"] : ["StreamEncoder", "Encoder"];
  for (const name of names) {
    const value = await readProfileParam(obs, category, name);
    if (value) return value;
  }
  return null;
}

async function readCanvasFps(obs: ObsClient): Promise<{ fpsNumerator: number; fpsDenominator: number }> {
  try {
    const video = await obs.call<{ fpsNumerator?: number; fpsDenominator?: number }>("GetVideoSettings");
    const fpsNumerator = video.fpsNumerator && video.fpsNumerator > 0 ? video.fpsNumerator : DEFAULT_CANVAS_FPS;
    const fpsDenominator = video.fpsDenominator && video.fpsDenominator > 0 ? video.fpsDenominator : 1;
    return { fpsNumerator, fpsDenominator };
  } catch {
    // Canvas is 30 fps in this app. Used when GetVideoSettings is unavailable.
    return { fpsNumerator: DEFAULT_CANVAS_FPS, fpsDenominator: 1 };
  }
}

/**
 * OWNERSHIP RULE EXCEPTION — documented and deliberate (HQ, 2026-09-15,
 * whatnot-show-tools-measured.md). Whatnot's Show Tools page cannot apply
 * four Output settings itself and instructs the seller to set them
 * manually: Bitrate max 3500 Kbps (range 2500-3500), Keyframe Interval 2s,
 * Rate Control CBR, Tune zerolatency. Since Whatnot's page never writes
 * these itself, writing them here creates no conflict with the file-level
 * ownership rule — `SetStreamServiceSettings` remains untouched forever,
 * and so does everything else in Output/Stream, including `Output/Mode`.
 *
 * Where the four values actually live, and why we do not write AdvOut/*:
 * - Read `Output/Mode` first. Never change it. Whatnot's "update profile"
 *   button sets Advanced; flipping Mode here would be a fifth owned setting.
 * - Simple mode is governed by `[SimpleOutput]`. We write `VBitrate` there
 *   always, and `UseAdvanced` + `x264Settings=keyint=<2*fps> tune=zerolatency`
 *   only when *that category's* `StreamEncoder` is already x264.
 * - Advanced mode is governed by `streamEncoder.json` (`bitrate`,
 *   `keyint_sec`, `rate_control`, `tune`) plus `[AdvOut] Encoder`.
 *   `SetProfileParameter` cannot populate that JSON. `AdvOut/VBitrate` and
 *   `AdvOut/x264Settings` are not keys OBS reads for the stream encode —
 *   the live "Whatnot Studio Test" profile has neither, and its
 *   `streamEncoder.json` is `{}`. Writing them is the same stored≠governs
 *   trap as the original SimpleOutput read-back. The JSON is written by
 *   `runFirstRunSetup` after OBS exits so the relaunch (and Whatnot's later
 *   Mode=Advanced) actually loads it.
 * - SimpleOutput and AdvOut keep independent encoder ids. This machine's
 *   Untitled profile is Simple=nvenc / AdvOut=obs_nvenc_h264_tex; the
 *   throwaway test profile is Simple=nvenc / AdvOut=obs_x264. Mirroring
 *   x264Settings from the governing encoder onto the other category is
 *   how keyint/tune silently stop applying after Whatnot flips Mode.
 *
 * `keyint` in Simple `x264Settings` is 2 * fps (frames). Advanced JSON
 * uses `keyint_sec` (seconds) — the encoder UI's unit, fps-independent.
 *
 * NVENC/AMF/QuickSync are not an edge case — this machine's default
 * Simple encoder was nvenc. Those encoders have no `x264Settings`/`tune`
 * field. Bitrate (and, in the encoder JSON, `keyint_sec` + CBR) still
 * apply; tune does not. A warning is returned rather than staying silent.
 * We do not force x264 onto the seller.
 */
export async function applyWhatnotEncoderSettings(obs: ObsClient): Promise<EncoderSettingsResult> {
  const mode = await readProfileParam(obs, "Output", "Mode");
  const { fpsNumerator, fpsDenominator } = await readCanvasFps(obs);
  const keyint = keyintForIntervalSec(fpsNumerator, fpsDenominator);

  const simpleEncoder = await readCategoryEncoder(obs, "SimpleOutput");
  const advEncoder = await readCategoryEncoder(obs, "AdvOut");

  await setProfileParam(obs, "SimpleOutput", "VBitrate", WHATNOT_VBITRATE);

  if (isX264Encoder(simpleEncoder)) {
    await setProfileParam(obs, "SimpleOutput", "UseAdvanced", "true");
    await setProfileParam(obs, "SimpleOutput", "x264Settings", `keyint=${keyint} tune=zerolatency`);
  }

  const governingEncoder = mode === "Advanced" ? advEncoder : simpleEncoder;
  const governingIsX264 = isX264Encoder(governingEncoder);
  const advIsX264 = isX264Encoder(advEncoder);
  if (governingIsX264 && advIsX264) {
    return {};
  }

  const named = !advIsX264 ? (advEncoder ?? "unset") : (governingEncoder ?? "unset");
  return {
    encoderWarning:
      `Streaming encoder is "${named}", not x264. ` +
      `Whatnot requires a ${KEYFRAME_INTERVAL_SEC}-second keyframe interval and Tune=zerolatency; ` +
      `those are x264 settings and were not written to the encoder that will govern after ` +
      `Whatnot sets Output Mode to Advanced. ` +
      `Bitrate is still capped at ${WHATNOT_VBITRATE} Kbps on SimpleOutput and in streamEncoder.json. ` +
      `Set OBS Output → Streaming Encoder to x264 to apply the remaining required values.`,
  };
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

  const encoderJsonPath =
    deps.paths.streamEncoderJsonPath ?? streamEncoderJsonPathFromProfileIni(deps.paths.profileIniPath);
  const encoderJson = JSON.stringify(buildWhatnotStreamEncoderJson());
  await deps.fs.mkdir(deps.fs.dirname(encoderJsonPath));
  await deps.fs.writeFile(encoderJsonPath, encoderJson);

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
  const { encoderWarning } = await applyWhatnotEncoderSettings(obs);
  await obs.disconnect();

  // The canvas setting only takes effect for Whatnot's health check after a
  // full restart (FINDINGS.md check 3) — this is a one-time cost.
  await deps.closeObs(pid);
  // OBS may dump in-memory encoder settings over streamEncoder.json on
  // exit. Rewrite after close so the relaunch (and Whatnot's later
  // Mode=Advanced) loads bitrate/keyint_sec/CBR/tune rather than `{}`.
  await deps.fs.writeFile(encoderJsonPath, encoderJson);
  const relaunched = await deps.launch();
  const obs2 = await deps.connect();
  await obs2.disconnect();

  return { ok: true, pid: relaunched.pid, versionWarning, encoderWarning };
}
