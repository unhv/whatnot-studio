/**
 * Upload + loaded-latency probe. Runs in the main process so the sandboxed
 * renderer never talks to the network for this. Cloudflare's public speed
 * endpoints accept POSTs without an API key; a failure/timeout is a valid
 * result (Automatic then picks Steady).
 */
import {
  median,
  sustainedKbpsFromSamples,
  type ByteSample,
  type UploadProbeResult,
} from "../src/obs/quality.js";

const UP_URL = "https://speed.cloudflare.com/__up";
const PING_URL = "https://speed.cloudflare.com/__down?bytes=0";
const CHUNK_BYTES = 256 * 1024;
const DEFAULT_DURATION_MS = 6000;
const DEFAULT_TIMEOUT_MS = 12000;

function withCacheBust(url: string, t: number): string {
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}nocache=${t}`;
}

export interface UploadProbeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  durationMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  chunkBytes?: number;
  maxRounds?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runUploadProbe(deps: UploadProbeDeps = {}): Promise<UploadProbeResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const durationMs = deps.durationMs ?? DEFAULT_DURATION_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const chunkBytes = deps.chunkBytes ?? CHUNK_BYTES;
  const maxRounds = deps.maxRounds ?? Number.POSITIVE_INFINITY;

  if (typeof fetchImpl !== "function") {
    return { outcome: "unavailable", sustainedKbps: null, loadedRttMs: null };
  }

  const started = now();
  const measureUntil = started + durationMs;
  const deadline = started + timeoutMs;
  const samples: ByteSample[] = [{ ms: 0, bytes: 0 }];
  const rtts: number[] = [];
  let uploaded = 0;
  let failed = false;
  let timedOut = false;

  const timedOutFlag = { value: false };

  const timeoutPromise = sleep(timeoutMs).then(() => {
    timedOutFlag.value = true;
    timedOut = true;
  });

  async function pingOnce(): Promise<void> {
    const t0 = now();
    try {
      const res = await fetchImpl(withCacheBust(PING_URL, t0), { method: "GET" });
      if (typeof res?.ok === "boolean" && !res.ok) return;
      rtts.push(now() - t0);
    } catch {
      // a missed ping is not a failed upload test
    }
  }

  async function uploadOnce(): Promise<void> {
    try {
      const res = await fetchImpl(withCacheBust(UP_URL, now()), {
        method: "POST",
        body: new Uint8Array(chunkBytes),
      });
      if (typeof res?.ok === "boolean" && !res.ok) {
        failed = true;
        return;
      }
      uploaded += chunkBytes;
      samples.push({ ms: now() - started, bytes: uploaded });
    } catch {
      failed = true;
    }
  }

  async function runLoops(): Promise<void> {
    const pings: Promise<void>[] = [];
    let rounds = 0;
    while (
      now() < measureUntil &&
      now() < deadline &&
      !timedOutFlag.value &&
      !failed &&
      rounds < maxRounds
    ) {
      rounds += 1;
      pings.push(pingOnce());
      await uploadOnce();
      if (failed) break;
    }
    await Promise.all(pings);
  }

  await Promise.race([runLoops(), timeoutPromise]);

  if (failed) {
    return { outcome: "failed", sustainedKbps: null, loadedRttMs: median(rtts) };
  }
  if (timedOut) {
    return { outcome: "timeout", sustainedKbps: null, loadedRttMs: median(rtts) };
  }

  // Incomplete if every sample is still in slow-start. Do not untrim:
  // a one-millisecond burst is not a sustained rate and would select Best.
  const sustainedKbps = sustainedKbpsFromSamples(samples);
  if (sustainedKbps == null) {
    return {
      outcome: "failed",
      sustainedKbps: null,
      loadedRttMs: median(rtts),
    };
  }

  return {
    outcome: "ok",
    sustainedKbps,
    loadedRttMs: median(rtts),
  };
}
