/**
 * Honest live-show health. Nothing adapts mid-show (WHIP has no Dynamic
 * Bitrate) and this app never restarts the stream. The indicator is polled
 * slowly from GetStreamStatus / GetStats.
 *
 * outputCongestion is RTMP-oriented and reads ~0 on WHIP — do not use it.
 * Network trouble and machine trouble are different faults.
 */

export const HEALTH_NETWORK = "Your internet is struggling — the picture may go blocky.";
export const HEALTH_MACHINE = "Your computer is working hard — closing other apps will help.";

/** Slow poll so a one-second blip cannot flash a warning mid-sale. */
export const HEALTH_POLL_MS = 4000;
/** Ignore render-skip spikes from scene compile / DirectShow warm-up. */
export const HEALTH_WARMUP_MS = 15000;
const STRIKES_NEEDED = 2;
const OUTPUT_SKIP_DELTA = 5;
const RENDER_SKIP_DELTA = 10;
const CPU_HIGH = 85;

export type HealthKind = "network" | "machine";

export interface HealthWarning {
  kind: HealthKind;
  message: string;
}

export interface HealthSample {
  outputSkippedFrames: number;
  outputBytes: number;
  renderSkippedFrames: number;
  cpuUsage: number;
  reconnecting: boolean;
  live: boolean;
  /** Present so tests can prove it is ignored. Never used for the verdict. */
  outputCongestion?: number;
}

export interface HealthState {
  warmupUntil: number;
  last: HealthSample | null;
  networkStrikes: number;
  machineStrikes: number;
  warning: HealthWarning | null;
}

export function initialHealthState(now: number, warmupMs: number = HEALTH_WARMUP_MS): HealthState {
  return {
    warmupUntil: now + warmupMs,
    last: null,
    networkStrikes: 0,
    machineStrikes: 0,
    warning: null,
  };
}

function networkTrouble(prev: HealthSample | null, sample: HealthSample, inWarmup: boolean): boolean {
  if (!sample.live && !sample.reconnecting) return false;
  if (sample.reconnecting) return true;
  if (!prev) return false;
  const skipDelta = sample.outputSkippedFrames - prev.outputSkippedFrames;
  if (skipDelta > OUTPUT_SKIP_DELTA) return true;
  // Byte counters legitimately sit at zero before the output has really
  // started (scene compile / DirectShow warm-up) — that is nothing having
  // been sent yet, not a stall. Only trust the stalled-bytes signal once
  // warmup has passed; a genuine stall keeps failing on every later poll.
  if (inWarmup) return false;
  const byteDelta = sample.outputBytes - prev.outputBytes;
  if (sample.live && byteDelta <= 0) return true;
  return false;
}

function machineTrouble(prev: HealthSample | null, sample: HealthSample, inWarmup: boolean): boolean {
  if (inWarmup) return false;
  if (!prev) return false;
  const renderDelta = sample.renderSkippedFrames - prev.renderSkippedFrames;
  return renderDelta > RENDER_SKIP_DELTA && sample.cpuUsage >= CPU_HIGH;
}

/**
 * Fold one poll. A single bad sample never produces a warning. Congestion
 * is accepted on the sample object and deliberately unused.
 */
export function foldHealth(prev: HealthState, sample: HealthSample, now: number): HealthState {
  void sample.outputCongestion;
  const inWarmup = now < prev.warmupUntil;
  const netHit = networkTrouble(prev.last, sample, inWarmup);
  const machineHit = machineTrouble(prev.last, sample, inWarmup);
  const networkStrikes = netHit ? prev.networkStrikes + 1 : 0;
  const machineStrikes = machineHit ? prev.machineStrikes + 1 : 0;

  let warning: HealthWarning | null = null;
  if (networkStrikes >= STRIKES_NEEDED) {
    warning = { kind: "network", message: HEALTH_NETWORK };
  } else if (machineStrikes >= STRIKES_NEEDED) {
    warning = { kind: "machine", message: HEALTH_MACHINE };
  }

  return {
    warmupUntil: prev.warmupUntil,
    last: sample,
    networkStrikes,
    machineStrikes,
    warning,
  };
}

export function healthSampleFromObs(
  stream: {
    outputSkippedFrames?: number;
    outputBytes?: number;
    outputCongestion?: number;
  },
  stats: {
    renderSkippedFrames?: number;
    cpuUsage?: number;
  },
  flags: { live: boolean; reconnecting: boolean }
): HealthSample {
  return {
    outputSkippedFrames: stream.outputSkippedFrames ?? 0,
    outputBytes: stream.outputBytes ?? 0,
    renderSkippedFrames: stats.renderSkippedFrames ?? 0,
    cpuUsage: stats.cpuUsage ?? 0,
    reconnecting: flags.reconnecting,
    live: flags.live,
    outputCongestion: stream.outputCongestion,
  };
}
