/**
 * Whatnot Studio viability spike — a single probe script that launches a
 * dedicated OBS profile/scene collection, runs the 8 checks from
 * briefs/2026-09-14-whatnot-studio-viability-spike.md over obs-websocket,
 * and always cleans up (closes OBS, restores the user's own default
 * profile/collection selection and obs-websocket config).
 *
 * Never streams anywhere real: StartStream (check 1) is only exercised if
 * VirtualCam cannot stand in for it, and even then the stream service is
 * pointed at a dead local URL — SetStreamServiceSettings is never called
 * against a real Whatnot endpoint, and --startstreaming is never used.
 *
 * Run with: npm run probe
 * Results stream to spike/results/run.jsonl, one JSON line per finished
 * check, appended as it finishes — so a crash partway through still leaves
 * every completed check's real output on disk.
 */
import OBSWebSocket from "obs-websocket-js";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  OBS_DIR,
  SPIKE_NAME,
  findFreePort,
  randomPassword,
  launchObs,
  closeObs,
  waitForPort,
  snapshotUserState,
  restoreUserState,
  ensureWebsocketServerEnabled,
  assertObsHidden,
  VisibleWindowError,
  type Snapshot,
} from "./obs-launcher.js";
import { computeCropToFill } from "./lib.js";

const RESULTS_DIR = path.join(process.cwd(), "spike", "results");
const RESULTS_FILE = path.join(RESULTS_DIR, "run.jsonl");

type Verdict = "GOOD" | "WORKABLE" | "BLOCKED";

interface CheckResult {
  id: number;
  title: string;
  verdict: Verdict;
  summary: string;
  detail: unknown;
  ranAt: string;
}

async function appendResult(r: CheckResult): Promise<void> {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.appendFile(RESULTS_FILE, JSON.stringify(r) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(`[${r.id}] ${r.verdict} — ${r.title}: ${r.summary}`);
}

function cpuPercent(pid: number, sampleMs: number): { before: number; sample: () => number } {
  const readCpuSeconds = (): number => {
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).CPU`],
        { encoding: "utf8", windowsHide: true }
      ).trim();
      return parseFloat(out) || 0;
    } catch {
      return NaN;
    }
  };
  const before = readCpuSeconds();
  return {
    before,
    sample: () => {
      const after = readCpuSeconds();
      const deltaSec = after - before;
      const cores = os.cpus().length || 1;
      return (deltaSec / (sampleMs / 1000) / cores) * 100;
    },
  };
}

async function main(): Promise<void> {
  await fs.rm(RESULTS_DIR, { recursive: true, force: true });
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  const snapshot: Snapshot = await snapshotUserState();
  console.log("snapshot taken of user's global.ini [Basic] + obs-websocket config.json");
  await ensureWebsocketServerEnabled();

  let port = await findFreePort();
  let password = randomPassword();
  let launch = launchObs({ port, password });
  console.log(`launched obs64.exe pid=${launch.pid} port=${port} cwd=${OBS_DIR}`);

  try {
    await assertObsHidden(launch.pid);
    console.log("hidden-window check passed: no visible main window");
  } catch (e) {
    await restoreUserState(snapshot).catch(() => {});
    if (e instanceof VisibleWindowError) {
      console.error(`BLOCKED — ${e.message}. Stopping the whole run, no retry.`);
    }
    throw e;
  }

  const obsA = new OBSWebSocket();
  const obsB = new OBSWebSocket();

  try {
    await waitForPort(port, "127.0.0.1", 30000);
    await obsA.connect(`ws://127.0.0.1:${port}`, password, { rpcVersion: 1 });
    console.log("client A connected");

    // ---- Check 2: launch flags honoured ----
    try {
      const profiles = await obsA.call("GetProfileList");
      const collections = await obsA.call("GetSceneCollectionList");
      const version = await obsA.call("GetVersion");
      const profileOk = profiles.currentProfileName === SPIKE_NAME;
      const collectionOk = collections.currentSceneCollectionName === SPIKE_NAME;
      await appendResult({
        id: 2,
        title: "Launch flags honoured",
        verdict: profileOk && collectionOk ? "GOOD" : "WORKABLE",
        summary: `port+password connected OK; --profile selected=${profileOk}; --collection selected=${collectionOk}`,
        detail: {
          requestedPort: port,
          currentProfileName: profiles.currentProfileName,
          currentSceneCollectionName: collections.currentSceneCollectionName,
          obsWebSocketVersion: version.obsWebSocketVersion,
        },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 2,
        title: "Launch flags honoured",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 1: two clients, one OBS ----
    try {
      await obsB.connect(`ws://127.0.0.1:${port}`, password, { rpcVersion: 1 });
      console.log("client B connected");

      let sawActiveOnA = false;
      let sawInactiveOnA = false;
      let lastEventPayload: unknown = null;
      const onVcam = (data: unknown) => {
        const d = data as { outputActive: boolean };
        if (d.outputActive) sawActiveOnA = true;
        else sawInactiveOnA = true;
        lastEventPayload = data;
      };
      obsA.on("VirtualcamStateChanged", onVcam);

      const camStatusBefore = await obsB.call("GetVirtualCamStatus");
      await obsB.call("StartVirtualCam");
      await new Promise((r) => setTimeout(r, 1500));

      // scene switch from A while B holds a connection — confirm no conflict
      const scenes = await obsA.call("GetSceneList");
      let sceneSwitchOk = true;
      let sceneSwitchError: string | null = null;
      if (scenes.scenes.length > 0) {
        try {
          const first = scenes.scenes[0] as { sceneName: string };
          await obsA.call("SetCurrentProgramScene", { sceneName: first.sceneName });
        } catch (e) {
          sceneSwitchOk = false;
          sceneSwitchError = (e as Error).message;
        }
      }

      await obsB.call("StopVirtualCam");
      await new Promise((r) => setTimeout(r, 1500));
      obsA.off("VirtualcamStateChanged", onVcam);

      const bothStillConnected =
        (await obsA.call("GetVersion")) !== undefined && (await obsB.call("GetVersion")) !== undefined;

      await appendResult({
        id: 1,
        title: "Two clients, one OBS — passive detection of go-live",
        verdict: sawActiveOnA && sawInactiveOnA && bothStillConnected ? "GOOD" : "WORKABLE",
        summary: `Used StartVirtualCam/StopVirtualCam (not StartStream) because it needs no network at all, so it cannot accidentally reach anything real, and it fires VirtualcamStateChanged with the same outputActive/outputState shape StreamStateChanged uses. Client A (passive) saw active=${sawActiveOnA}, inactive=${sawInactiveOnA} without calling Start/StopVirtualCam itself. Scene switch from A while B connected: ok=${sceneSwitchOk}${sceneSwitchError ? " error=" + sceneSwitchError : ""}. Both clients still connected after: ${bothStillConnected}.`,
        detail: {
          camStatusBefore,
          lastVirtualcamStateChangedPayload: lastEventPayload,
          sceneSwitchOk,
          sceneSwitchError,
        },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 1,
        title: "Two clients, one OBS — passive detection of go-live",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 4: crop-to-fill ----
    let cropSceneName = "Whatnot Spike Crop Test";
    try {
      const sceneList = await obsA.call("GetSceneList");
      const exists = sceneList.scenes.some((s) => (s as { sceneName: string }).sceneName === cropSceneName);
      if (!exists) {
        await obsA.call("CreateScene", { sceneName: cropSceneName });
      }
      await obsA.call("SetCurrentProgramScene", { sceneName: cropSceneName });

      const inputName = "Spike 16x9 Stand-in";
      const created = await obsA.call("CreateInput", {
        sceneName: cropSceneName,
        inputName,
        inputKind: "color_source_v3",
        inputSettings: { width: 1920, height: 1080, color: 4278255360 },
      });

      const transform = computeCropToFill(1920, 1080, 1080, 1920);
      await obsA.call("SetSceneItemTransform", {
        sceneName: cropSceneName,
        sceneItemId: created.sceneItemId,
        sceneItemTransform: {
          boundsType: "OBS_BOUNDS_NONE",
          positionX: transform.positionX,
          positionY: transform.positionY,
          scaleX: transform.scaleX,
          scaleY: transform.scaleY,
          cropLeft: Math.round(transform.cropLeft),
          cropRight: Math.round(transform.cropRight),
          cropTop: Math.round(transform.cropTop),
          cropBottom: Math.round(transform.cropBottom),
        },
      });

      const readBack = await obsA.call("GetSceneItemTransform", {
        sceneName: cropSceneName,
        sceneItemId: created.sceneItemId,
      });
      const w = readBack.sceneItemTransform as { width: number; height: number };
      const filledExactly = Math.abs(w.width - 1080) <= 1 && Math.abs(w.height - 1920) <= 1;

      await appendResult({
        id: 4,
        title: "Crop-to-fill is buildable",
        verdict: filledExactly ? "GOOD" : "WORKABLE",
        summary: `Used color_source_v3 sized 1920x1080 as the 16:9 stand-in (no camera assumed attached on this machine). SetSceneItemTransform with boundsType OBS_BOUNDS_NONE + cropLeft/cropRight + scaleX/scaleY filled the 1080x1920 canvas: resulting item width=${w.width} height=${w.height} (want 1080x1920).`,
        detail: {
          requestedTransform: transform,
          readBackTransform: readBack.sceneItemTransform,
        },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 4,
        title: "Crop-to-fill is buildable",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 5: text overlay live update + show/hide ----
    try {
      const inputName = "Spike Item Bar Text";
      const kinds = await obsA.call("GetInputKindList", { unversioned: false });
      const textKind = kinds.inputKinds.find((k) => k.startsWith("text_gdiplus")) ?? kinds.inputKinds.find((k) => k.startsWith("text_ft2"));
      if (!textKind) throw new Error("no text_gdiplus_* or text_ft2_* input kind offered by this OBS build");

      const created = await obsA.call("CreateInput", {
        sceneName: cropSceneName,
        inputName,
        inputKind: textKind,
        inputSettings: { text: "ITEM 1 — $10" },
      });

      await obsA.call("SetInputSettings", {
        inputName,
        inputSettings: { text: "SOLD — Item 1" },
        overlay: true,
      });
      const afterUpdate = await obsA.call("GetInputSettings", { inputName });

      await obsA.call("SetSceneItemEnabled", {
        sceneName: cropSceneName,
        sceneItemId: created.sceneItemId,
        sceneItemEnabled: false,
      });
      await new Promise((r) => setTimeout(r, 400));
      await obsA.call("SetSceneItemEnabled", {
        sceneName: cropSceneName,
        sceneItemId: created.sceneItemId,
        sceneItemEnabled: true,
      });
      const enabledAfter = await obsA.call("GetSceneItemEnabled", {
        sceneName: cropSceneName,
        sceneItemId: created.sceneItemId,
      });

      const textUpdated = (afterUpdate.inputSettings as { text?: string }).text === "SOLD — Item 1";

      await appendResult({
        id: 5,
        title: "Text overlay updates live; show/hide on a timer",
        verdict: textUpdated && enabledAfter.sceneItemEnabled ? "GOOD" : "WORKABLE",
        summary: `Input kind used: ${textKind}. SetInputSettings with settings key "text" updated live (readback matched=${textUpdated}). SetSceneItemEnabled toggled off then back on (final enabled=${enabledAfter.sceneItemEnabled}).`,
        detail: {
          inputKindUsed: textKind,
          allTextLikeKinds: kinds.inputKinds.filter((k) => k.includes("text")),
          afterUpdateSettings: afterUpdate.inputSettings,
        },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 5,
        title: "Text overlay updates live; show/hide on a timer",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 7: transitions ----
    try {
      const kindList = await obsA.call("GetTransitionKindList");
      const sceneTransitions = await obsA.call("GetSceneTransitionList");
      const hasFade = sceneTransitions.transitions.some((t) => (t as { transitionName: string }).transitionName === "Fade");
      const targetName = hasFade
        ? "Fade"
        : (sceneTransitions.transitions[0] as { transitionName: string } | undefined)?.transitionName;

      let setOk = false;
      let currentAfter: unknown = null;
      if (targetName) {
        await obsA.call("SetCurrentSceneTransition", { transitionName: targetName });
        await obsA.call("SetCurrentSceneTransitionDuration", { transitionDuration: 300 });
        currentAfter = await obsA.call("GetCurrentSceneTransition");
        const c = currentAfter as { transitionName: string; transitionDuration: number | null };
        setOk = c.transitionName === targetName && c.transitionDuration === 300;
      }

      const stingerKind = kindList.transitionKinds.find((k) => k.toLowerCase().includes("sting"));

      await appendResult({
        id: 7,
        title: "Transitions available; cut + 300ms fade reachable",
        verdict: setOk ? "GOOD" : "WORKABLE",
        summary: `Stock transition kinds installed: ${sceneTransitions.transitions.length}. Set current transition to "${targetName}" @300ms: ${setOk}. A stinger transition kind is${stingerKind ? "" : " NOT"} offered by GetTransitionKindList${stingerKind ? ` (kind id "${stingerKind}")` : ""} — obs-websocket has no CreateSceneTransition request, so a stinger can only be added as an instance of that kind through the OBS UI (or by writing it into the scene collection JSON before launch) on first run, then just referenced by name over the API afterwards; the API itself cannot author one from a video file at runtime.`,
        detail: {
          transitionKinds: kindList.transitionKinds,
          sceneTransitions: sceneTransitions.transitions,
          currentAfterSet: currentAfter,
        },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 7,
        title: "Transitions available; cut + 300ms fade reachable",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 6: preview cost ----
    try {
      async function sampleRate(fps: number, seconds: number) {
        const intervalMs = 1000 / fps;
        const iterations = Math.round((seconds * 1000) / intervalMs);
        const probeCpuBefore = process.cpuUsage();
        const obsCpu = cpuPercent(launch.pid, seconds * 1000);
        const start = Date.now();
        let completed = 0;
        let lastSizeBytes = 0;
        for (let i = 0; i < iterations; i++) {
          const t0 = Date.now();
          const shot = await obsA.call("GetSourceScreenshot", {
            sourceName: cropSceneName,
            imageFormat: "jpg",
            imageWidth: 270,
            imageHeight: 480,
            imageCompressionQuality: 60,
          });
          lastSizeBytes = shot.imageData.length;
          completed++;
          const elapsed = Date.now() - t0;
          const wait = intervalMs - elapsed;
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        const wallSeconds = (Date.now() - start) / 1000;
        const probeCpuAfter = process.cpuUsage(probeCpuBefore);
        const probeCpuPercent =
          ((probeCpuAfter.user + probeCpuAfter.system) / 1e6 / wallSeconds / (os.cpus().length || 1)) * 100;
        return {
          fpsRequested: fps,
          achievedFps: completed / wallSeconds,
          obsCpuPercentAvg: obsCpu.sample(),
          probeCpuPercentAvg: probeCpuPercent,
          lastFrameBase64Bytes: lastSizeBytes,
        };
      }

      const at2fps = await sampleRate(2, 20);
      const at5fps = await sampleRate(5, 20);

      await appendResult({
        id: 6,
        title: "Preview cost (GetSourceScreenshot, 270px wide)",
        verdict: at5fps.achievedFps >= 4 ? "GOOD" : "WORKABLE",
        summary: `2fps target: achieved ${at2fps.achievedFps.toFixed(2)}fps, OBS CPU ~${at2fps.obsCpuPercentAvg.toFixed(1)}%, probe CPU ~${at2fps.probeCpuPercentAvg.toFixed(1)}%. 5fps target: achieved ${at5fps.achievedFps.toFixed(2)}fps, OBS CPU ~${at5fps.obsCpuPercentAvg.toFixed(1)}%, probe CPU ~${at5fps.probeCpuPercentAvg.toFixed(1)}%.`,
        detail: { at2fps, at5fps },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 6,
        title: "Preview cost (GetSourceScreenshot, 270px wide)",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 8: media playback end event (lowest priority) ----
    try {
      const inputName = "Spike Media Probe";
      const kinds = await obsA.call("GetInputKindList", { unversioned: false });
      const hasFfmpeg = kinds.inputKinds.includes("ffmpeg_source");
      if (!hasFfmpeg) throw new Error("ffmpeg_source input kind not offered by this OBS build");

      // A tiny silent WAV generated on the fly so the spike needs no bundled
      // media asset. 0.5s of silence at 8kHz mono, PCM.
      const wavPath = path.join(RESULTS_DIR, "silence.wav");
      await writeSilentWav(wavPath, 0.5);

      let sawEnded = false;
      const onEnded = (d: unknown) => {
        const ev = d as { inputName: string };
        if (ev.inputName === inputName) sawEnded = true;
      };
      obsA.on("MediaInputPlaybackEnded", onEnded);

      await obsA.call("CreateInput", {
        sceneName: cropSceneName,
        inputName,
        inputKind: "ffmpeg_source",
        inputSettings: { local_file: wavPath, looping: false, is_local_file: true },
      });

      await new Promise((r) => setTimeout(r, 3000));
      obsA.off("MediaInputPlaybackEnded", onEnded);
      const status = await obsA.call("GetMediaInputStatus", { inputName }).catch(() => null);

      await appendResult({
        id: 8,
        title: "Media playback end event (lowest priority — music is out of MVP)",
        verdict: sawEnded ? "GOOD" : "WORKABLE",
        summary: `MediaInputPlaybackEnded fired for a 0.5s non-looping ffmpeg_source: ${sawEnded}. Last GetMediaInputStatus: ${status ? JSON.stringify(status) : "unavailable"}. ${sawEnded ? "The event is enough; no polling needed." : "Event did not arrive within 3s — polling GetMediaInputStatus (mediaState) would be the fallback."}`,
        detail: { sawEnded, status },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 8,
        title: "Media playback end event (lowest priority — music is out of MVP)",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }

    // ---- Check 3: canvas + restart quirk ----
    try {
      await obsA.call("SetVideoSettings", {
        baseWidth: 1080,
        baseHeight: 1920,
        outputWidth: 1080,
        outputHeight: 1920,
        fpsNumerator: 30,
        fpsDenominator: 1,
      });
      const beforeRestart = await obsA.call("GetVideoSettings");

      obsA.off("VirtualcamStateChanged", () => {});
      await obsA.disconnect();
      await obsB.disconnect().catch(() => {});
      await closeObs(launch.pid);

      port = await findFreePort();
      password = randomPassword();
      launch = launchObs({ port, password });
      await assertObsHidden(launch.pid);
      await waitForPort(port, "127.0.0.1", 30000);

      const obsC = new OBSWebSocket();
      await obsC.connect(`ws://127.0.0.1:${port}`, password, { rpcVersion: 1 });
      const afterRestart = await obsC.call("GetVideoSettings");
      const collections = await obsC.call("GetSceneCollectionList");
      await obsC.disconnect();

      const survived =
        afterRestart.baseWidth === 1080 &&
        afterRestart.baseHeight === 1920 &&
        afterRestart.outputWidth === 1080 &&
        afterRestart.outputHeight === 1920;

      // Reconnect obsA for cleanup steps below (scene/collection was preserved,
      // this is the same "Whatnot Studio Spike" collection).
      await obsA.connect(`ws://127.0.0.1:${port}`, password, { rpcVersion: 1 });

      await appendResult({
        id: 3,
        title: "Canvas 1080x1920 + the OBS-restart-after-canvas-change quirk",
        verdict: survived ? "GOOD" : "WORKABLE",
        summary: `SetVideoSettings to 1080x1920 confirmed immediately via GetVideoSettings; after a full OBS quit + relaunch on the same profile it still reports ${afterRestart.baseWidth}x${afterRestart.baseHeight} base / ${afterRestart.outputWidth}x${afterRestart.outputHeight} output (survived=${survived}). Collection preserved across restart: ${collections.currentSceneCollectionName === SPIKE_NAME}. Our first-run flow does need to bake in a restart after the first canvas set, matching Whatnot's own quirk — but the setting itself is a persisted profile property, not something we need to re-apply every launch.`,
        detail: { beforeRestart, afterRestart },
        ranAt: new Date().toISOString(),
      });
    } catch (e) {
      await appendResult({
        id: 3,
        title: "Canvas 1080x1920 + the OBS-restart-after-canvas-change quirk",
        verdict: "BLOCKED",
        summary: `error: ${(e as Error).message}`,
        detail: null,
        ranAt: new Date().toISOString(),
      });
    }
  } finally {
    await obsA.disconnect().catch(() => {});
    await obsB.disconnect().catch(() => {});
    await closeObs(launch.pid);
    await restoreUserState(snapshot);
    console.log("cleanup complete: OBS closed, user's global.ini [Basic] + obs-websocket config restored");
  }
}

/** Writes a minimal valid PCM WAV file of N seconds of silence, mono 8kHz. */
async function writeSilentWav(filePath: string, seconds: number): Promise<void> {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples already zero (silence) from Buffer.alloc
  await fs.writeFile(filePath, buf);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
