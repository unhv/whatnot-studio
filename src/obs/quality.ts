/**
 * Connection quality: resolution/bitrate presets chosen before going live,
 * an opt-in hardware encoder, and the upload probe that picks Automatic.
 *
 * This app streams over WHIP. OBS Dynamic Bitrate is an RTMP feature and
 * must never be enabled. Nothing here calls StartStream / StopStream —
 * Whatnot's Show Tools page owns Go Live. SetVideoSettings is skipped
 * while any output (stream, recording, virtual camera) is active because
 * obs_reset_video tears down DirectShow capture devices.
 */
import type { ObsClient } from "./client.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, type DeviceChoice, type QualityChoice } from "../shared/types.js";

export const WHATNOT_BITRATE_MIN_KBPS = 2500;
export const WHATNOT_BITRATE_MAX_KBPS = 3500;
export const KEYFRAME_INTERVAL_SEC = 2;
export const DEFAULT_CANVAS_FPS = 30;
export const WHATNOT_X264_PRESET = "veryfast";
export const WHATNOT_ADV_AUDIO_ENCODER = "ffmpeg_opus";
export const WHATNOT_SIMPLE_AUDIO_ENCODER = "opus";
export const WHATNOT_SIMULCAST_LAYERS = "1";

/** Simple-mode combo id for NVENC. Written only when the seller opts in. */
export const SIMPLE_HARDWARE_ENCODER = "nvenc";
/** Advanced-mode encoder id for NVENC on OBS 31. Written only on opt-in. */
export const ADV_HARDWARE_ENCODER = "obs_nvenc_h264_tex";
export const SIMPLE_SOFTWARE_ENCODER = "x264";
export const ADV_SOFTWARE_ENCODER = "obs_x264";

/** ~160 kbps is a typical Opus live-audio budget on top of video. */
export const AUDIO_KBPS = 160;
/** WHIP/WebRTC packet overhead. Subtracted from measured upload before compare. */
export const WEBRTC_OVERHEAD = 0.2;
/** Loaded RTT above this (ms) is bufferbloat — fast speed tests, bad streams. */
export const LOADED_RTT_BAD_MS = 250;
export const UPLOAD_SLOW_START_MS = 2000;

export type QualityPresetId = "best" | "steady";

export interface QualityPreset {
  id: QualityPresetId;
  label: "Best" | "Steady";
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
  bitrateKbps: number;
  keyframeIntervalSec: number;
}

export const QUALITY_PRESETS: Record<QualityPresetId, QualityPreset> = {
  best: {
    id: "best",
    label: "Best",
    outputWidth: CANVAS_WIDTH,
    outputHeight: CANVAS_HEIGHT,
    fpsNumerator: DEFAULT_CANVAS_FPS,
    fpsDenominator: 1,
    bitrateKbps: WHATNOT_BITRATE_MAX_KBPS,
    keyframeIntervalSec: KEYFRAME_INTERVAL_SEC,
  },
  steady: {
    id: "steady",
    label: "Steady",
    // OBS 1.5x downscale of 1080x1920; 16-pixel aligned.
    outputWidth: 720,
    outputHeight: 1280,
    fpsNumerator: DEFAULT_CANVAS_FPS,
    fpsDenominator: 1,
    bitrateKbps: WHATNOT_BITRATE_MIN_KBPS,
    keyframeIntervalSec: KEYFRAME_INTERVAL_SEC,
  },
};

export const QUALITY_PRESET_IDS = Object.keys(QUALITY_PRESETS) as QualityPresetId[];

export function getQualityPreset(id: QualityPresetId): QualityPreset {
  return QUALITY_PRESETS[id];
}

/** Safe default is the lower preset. Never fall back to Best. */
export function clampWhatnotBitrate(kbps: number): number {
  if (!Number.isFinite(kbps)) return WHATNOT_BITRATE_MIN_KBPS;
  const rounded = Math.round(kbps);
  if (rounded < WHATNOT_BITRATE_MIN_KBPS) return WHATNOT_BITRATE_MIN_KBPS;
  if (rounded > WHATNOT_BITRATE_MAX_KBPS) return WHATNOT_BITRATE_MAX_KBPS;
  return rounded;
}

export function streamEncoderJsonForBitrate(bitrateKbps: number): {
  bitrate: number;
  keyint_sec: number;
  rate_control: string;
  tune: string;
  preset: string;
} {
  return {
    bitrate: clampWhatnotBitrate(bitrateKbps),
    keyint_sec: KEYFRAME_INTERVAL_SEC,
    rate_control: "CBR",
    tune: "zerolatency",
    preset: WHATNOT_X264_PRESET,
  };
}

export type ProbeOutcome = "ok" | "failed" | "timeout" | "unavailable";

export interface UploadProbeResult {
  outcome: ProbeOutcome;
  /** Minimum windowed rate after slow-start, not the peak. */
  sustainedKbps: number | null;
  /** RTT while the upload is saturating the link. */
  loadedRttMs: number | null;
}

export interface ByteSample {
  ms: number;
  bytes: number;
}

/**
 * Windowed kbps from cumulative byte samples. Drops slow-start, then takes
 * the minimum remaining window — a peak would bless bufferbloat.
 */
export function sustainedKbpsFromSamples(
  samples: ByteSample[],
  slowStartMs: number = UPLOAD_SLOW_START_MS
): number | null {
  if (samples.length < 2) return null;
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    if (cur.ms < slowStartMs) continue;
    const dt = cur.ms - prev.ms;
    if (dt <= 0) continue;
    const dBytes = cur.bytes - prev.bytes;
    if (dBytes < 0) continue;
    rates.push((dBytes * 8) / dt);
  }
  if (rates.length === 0) return null;
  return Math.min(...rates);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function usableUploadKbps(sustainedKbps: number): number {
  return sustainedKbps * (1 - WEBRTC_OVERHEAD);
}

/**
 * Qualifier, not a bitrate oracle. Failed / timed-out / missing tests
 * always return Steady. Fast-but-bufferbloated links return Steady.
 */
export function chooseQualityPreset(probe: UploadProbeResult): QualityPresetId {
  if (probe.outcome !== "ok") return "steady";
  if (probe.sustainedKbps == null || !Number.isFinite(probe.sustainedKbps)) return "steady";
  const usable = usableUploadKbps(probe.sustainedKbps);
  const needBest = WHATNOT_BITRATE_MAX_KBPS + AUDIO_KBPS;
  if (usable < needBest) return "steady";
  if (probe.loadedRttMs != null && probe.loadedRttMs > LOADED_RTT_BAD_MS) return "steady";
  return "best";
}

export function automaticQualitySummary(outcome: ProbeOutcome, preset: QualityPresetId): string {
  const name = getQualityPreset(preset).label;
  if (outcome !== "ok") return `Couldn't test your upload — streaming at ${name}.`;
  return `Tested your upload — streaming at ${name}.`;
}

export function resolveQuality(
  choice: QualityChoice,
  probe: UploadProbeResult
): { preset: QualityPresetId; summary: string } {
  if (choice === "best") {
    return { preset: "best", summary: "Streaming at Best." };
  }
  if (choice === "steady") {
    return { preset: "steady", summary: "Streaming at Steady." };
  }
  const preset = chooseQualityPreset(probe);
  return { preset, summary: automaticQualitySummary(probe.outcome, preset) };
}

export async function prepareQualityForGoLive(opts: {
  choice: QualityChoice;
  probe: () => Promise<UploadProbeResult>;
}): Promise<{ preset: QualityPresetId; summary: string }> {
  if (opts.choice === "best" || opts.choice === "steady") {
    return resolveQuality(opts.choice, {
      outcome: "unavailable",
      sustainedKbps: null,
      loadedRttMs: null,
    });
  }
  try {
    const probe = await opts.probe();
    return resolveQuality("automatic", probe);
  } catch {
    return resolveQuality("automatic", {
      outcome: "failed",
      sustainedKbps: null,
      loadedRttMs: null,
    });
  }
}

export function isCameraMissingAfterApply(
  camera: DeviceChoice | null,
  videoDevices: DeviceChoice[]
): boolean {
  if (!camera || camera.deviceId === "") return false;
  return !videoDevices.some((d) => d.deviceId === camera.deviceId);
}

export async function anyObsOutputActive(obs: ObsClient): Promise<boolean> {
  for (const requestType of ["GetStreamStatus", "GetRecordStatus", "GetVirtualCamStatus"]) {
    try {
      const res = await obs.call<{ outputActive?: boolean }>(requestType);
      if (res.outputActive === true) return true;
    } catch {
      // A missing or failed status read is not "active".
    }
  }
  return false;
}

export async function applyVideoQuality(
  obs: ObsClient,
  preset: QualityPreset
): Promise<{ applied: boolean; reason?: "output-active" }> {
  if (await anyObsOutputActive(obs)) {
    return { applied: false, reason: "output-active" };
  }
  await obs.call("SetVideoSettings", {
    baseWidth: CANVAS_WIDTH,
    baseHeight: CANVAS_HEIGHT,
    outputWidth: preset.outputWidth,
    outputHeight: preset.outputHeight,
    fpsNumerator: preset.fpsNumerator,
    fpsDenominator: preset.fpsDenominator,
  });
  return { applied: true };
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
  const names = category === "AdvOut" ? ["Encoder", "StreamEncoder"] : ["StreamEncoder", "Encoder"];
  for (const name of names) {
    const value = await readProfileParam(obs, category, name);
    if (value) return value;
  }
  return null;
}

export interface EncoderIds {
  simple: string | null;
  adv: string | null;
}

export function isHardwareSimpleEncoder(id: string | null | undefined): boolean {
  return id === SIMPLE_HARDWARE_ENCODER;
}

export function isHardwareAdvEncoder(id: string | null | undefined): boolean {
  return id === ADV_HARDWARE_ENCODER;
}

/** Never persist NVENC as the revert target. */
export function softwareEncoderFallback(previous: EncoderIds | null | undefined): EncoderIds {
  const simple = previous?.simple;
  const adv = previous?.adv;
  return {
    simple: !simple || isHardwareSimpleEncoder(simple) ? SIMPLE_SOFTWARE_ENCODER : simple,
    adv: !adv || isHardwareAdvEncoder(adv) ? ADV_SOFTWARE_ENCODER : adv,
  };
}

/**
 * Keep the first software-to-hardware snapshot until revert/confirm.
 * A second apply while NVENC is already written must not replace it.
 */
export function nextHardwarePreviousSnapshot(
  stored: { pending: boolean; previous: EncoderIds },
  captured: EncoderIds
): EncoderIds {
  if (stored.pending && (stored.previous.simple != null || stored.previous.adv != null)) {
    return softwareEncoderFallback(stored.previous);
  }
  return softwareEncoderFallback(captured);
}

function encoderIdsAlreadyHardware(ids: EncoderIds): boolean {
  return isHardwareSimpleEncoder(ids.simple) && isHardwareAdvEncoder(ids.adv);
}

/**
 * Explicit opt-in only. Writes both namespaces that govern Simple vs
 * Advanced. Never flips Output/Mode. Stored ≠ will-encode: the next Go
 * Live is what confirms this; a failed Go Live must revert.
 *
 * Snapshot previous ids only on the first software-to-hardware
 * transition. Skip the write when both namespaces already hold the
 * hardware ids so a re-test cannot record NVENC as previous.
 */
export async function applyHardwareEncoderOptIn(
  obs: ObsClient,
  existingPrevious?: EncoderIds | null
): Promise<{ previous: EncoderIds; wrote: boolean }> {
  const current: EncoderIds = {
    simple: await readCategoryEncoder(obs, "SimpleOutput"),
    adv: await readCategoryEncoder(obs, "AdvOut"),
  };
  const previous = nextHardwarePreviousSnapshot(
    {
      pending: existingPrevious != null && (existingPrevious.simple != null || existingPrevious.adv != null),
      previous: existingPrevious ?? { simple: null, adv: null },
    },
    current
  );
  if (encoderIdsAlreadyHardware(current)) {
    return { previous, wrote: false };
  }
  await setProfileParam(obs, "SimpleOutput", "StreamEncoder", SIMPLE_HARDWARE_ENCODER);
  await setProfileParam(obs, "AdvOut", "Encoder", ADV_HARDWARE_ENCODER);
  return { previous, wrote: true };
}

export async function revertHardwareEncoder(obs: ObsClient, previous: EncoderIds): Promise<void> {
  const ids = softwareEncoderFallback(previous);
  await setProfileParam(obs, "SimpleOutput", "StreamEncoder", ids.simple || SIMPLE_SOFTWARE_ENCODER);
  await setProfileParam(obs, "AdvOut", "Encoder", ids.adv || ADV_SOFTWARE_ENCODER);
}

export const ENCODER_REVERT_MESSAGE =
  "Your graphics card encoder didn't start a live stream, so we switched it back.";

export const QUALITY_WHILE_LIVE = "If you want a different quality, set it before the next show.";

export const HARDWARE_ENCODER_LABEL = "Use my graphics card to encode (frees up your computer)";

export interface EncoderWatchState {
  pending: boolean;
  sawStarting: boolean;
  previous: EncoderIds;
}

export function idleEncoderWatch(): EncoderWatchState {
  return { pending: false, sawStarting: false, previous: { simple: null, adv: null } };
}

export function pendingEncoderWatch(previous: EncoderIds): EncoderWatchState {
  return { pending: true, sawStarting: false, previous };
}

function outputKind(outputState: string): string {
  return outputState.startsWith("OBS_WEBSOCKET_OUTPUT_")
    ? outputState.slice("OBS_WEBSOCKET_OUTPUT_".length)
    : outputState;
}

/**
 * The next Go Live must produce STARTED. STARTING then STOPPED (or any
 * stop without a live stream) reverts the opt-in.
 */
export function foldEncoderGoLive(
  prev: EncoderWatchState,
  event: { outputState: string }
): { next: EncoderWatchState; action: "none" | "confirm" | "revert" } {
  if (!prev.pending) return { next: prev, action: "none" };
  const kind = outputKind(event.outputState);
  if (kind === "STARTING") {
    return { next: { ...prev, sawStarting: true }, action: "none" };
  }
  if (kind === "STARTED") {
    return { next: { ...prev, pending: false, sawStarting: false }, action: "confirm" };
  }
  if (kind === "STOPPED" && prev.sawStarting) {
    return { next: { ...prev, pending: false, sawStarting: false }, action: "revert" };
  }
  return { next: prev, action: "none" };
}

export interface QualityApplyResult {
  videoApplied: boolean;
  videoSkipReason?: "output-active";
  cameraMissing: boolean;
  devices: { video: DeviceChoice[]; audio: DeviceChoice[] };
  previousEncoders?: EncoderIds;
}

/**
 * Apply a quality (and optional encoder) change: only while idle, then
 * re-enumerate so a camera that did not survive obs_reset_video is not
 * silently left dead.
 */
export async function applyQualityChange(opts: {
  obs: ObsClient;
  preset: QualityPreset;
  camera: DeviceChoice | null;
  enumerate: (obs: ObsClient) => Promise<{ video: DeviceChoice[]; audio: DeviceChoice[] }>;
  applyEncoderSettings: (obs: ObsClient) => Promise<unknown>;
  writeStreamEncoderJson?: (contents: string) => Promise<void>;
  hardwareEncoder?: boolean;
  /** First software-encoder snapshot; kept across a second opt-in apply. */
  existingPreviousEncoders?: EncoderIds | null;
}): Promise<QualityApplyResult> {
  if (await anyObsOutputActive(opts.obs)) {
    return {
      videoApplied: false,
      videoSkipReason: "output-active",
      cameraMissing: false,
      devices: { video: [], audio: [] },
    };
  }

  const video = await applyVideoQuality(opts.obs, opts.preset);
  await opts.applyEncoderSettings(opts.obs);

  let previousEncoders: EncoderIds | undefined;
  if (opts.hardwareEncoder) {
    previousEncoders = (await applyHardwareEncoderOptIn(opts.obs, opts.existingPreviousEncoders)).previous;
  } else if (
    opts.existingPreviousEncoders &&
    (opts.existingPreviousEncoders.simple != null || opts.existingPreviousEncoders.adv != null)
  ) {
    await revertHardwareEncoder(opts.obs, opts.existingPreviousEncoders);
  }

  if (opts.writeStreamEncoderJson) {
    await opts.writeStreamEncoderJson(JSON.stringify(streamEncoderJsonForBitrate(opts.preset.bitrateKbps)));
  }

  let devices = { video: [] as DeviceChoice[], audio: [] as DeviceChoice[] };
  try {
    devices = await opts.enumerate(opts.obs);
  } catch {
    devices = { video: [], audio: [] };
  }

  return {
    videoApplied: video.applied,
    videoSkipReason: video.reason,
    cameraMissing: isCameraMissingAfterApply(opts.camera, devices.video),
    devices,
    previousEncoders,
  };
}

export const FORBIDDEN_OBS_REQUESTS = ["StartStream", "StopStream"] as const;
export const FORBIDDEN_PROFILE_PARAMS = ["DynamicBitrate"] as const;
