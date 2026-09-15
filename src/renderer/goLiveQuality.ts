import type { ObsClient } from "../obs/client.js";
import { enumerateStudioDevices } from "../obs/devices.js";
import { applyWhatnotEncoderSettings } from "../obs/firstRun.js";
import {
  applyQualityChange,
  getQualityPreset,
  nextHardwarePreviousSnapshot,
  prepareQualityForGoLive,
  type UploadProbeResult,
} from "../obs/quality.js";
import { missingCameraMessage } from "../state/showStore.js";
import { useAppStore } from "../state/store.js";

export function studioBridge():
  | {
      probeUpload?: () => Promise<UploadProbeResult>;
      firstRunPaths?: () => Promise<{ streamEncoderJsonPath: string }>;
      writeFirstRunFiles?: (args: {
        streamEncoderJsonPath?: string;
        streamEncoderJson?: string;
      }) => Promise<void>;
    }
  | undefined {
  try {
    return typeof window !== "undefined" ? window.whatnotStudio : undefined;
  } catch {
    return undefined;
  }
}

export async function defaultProbeUpload(): Promise<UploadProbeResult> {
  const api = studioBridge();
  if (!api || typeof api.probeUpload !== "function") {
    return { outcome: "unavailable", sustainedKbps: null, loadedRttMs: null };
  }
  return api.probeUpload();
}

export async function defaultWriteStreamEncoderJson(contents: string): Promise<void> {
  const api = studioBridge();
  if (!api || typeof api.firstRunPaths !== "function" || typeof api.writeFirstRunFiles !== "function") return;
  const paths = await api.firstRunPaths();
  await api.writeFirstRunFiles({
    streamEncoderJsonPath: paths.streamEncoderJsonPath,
    streamEncoderJson: contents,
  });
}

/** Probe (Automatic) then idle-only SetVideoSettings, both encoder namespaces, streamEncoder.json, re-enumerate. */
export async function applyGoLiveQuality(opts: {
  obs: ObsClient;
  probe?: () => Promise<UploadProbeResult>;
  writeStreamEncoderJson?: (contents: string) => Promise<void>;
  enumerate?: typeof enumerateStudioDevices;
}): Promise<{ cameraMissing: boolean }> {
  const store = useAppStore.getState();
  const cfg = store.showConfig;
  store.setQualityTesting(true);
  try {
    const resolved = await prepareQualityForGoLive({
      choice: cfg.qualityChoice ?? "automatic",
      probe: opts.probe ?? defaultProbeUpload,
    });
    store.setShowConfig({ lastQualitySummary: resolved.summary });
    const applied = await applyQualityChange({
      obs: opts.obs,
      preset: getQualityPreset(resolved.preset),
      camera: cfg.camera,
      enumerate: opts.enumerate ?? enumerateStudioDevices,
      applyEncoderSettings: (obs) =>
        applyWhatnotEncoderSettings(obs, { bitrateKbps: getQualityPreset(resolved.preset).bitrateKbps }),
      writeStreamEncoderJson: opts.writeStreamEncoderJson ?? defaultWriteStreamEncoderJson,
      hardwareEncoder: cfg.hardwareEncoder === true,
      existingPreviousEncoders: {
        simple: cfg.previousSimpleEncoder ?? null,
        adv: cfg.previousAdvEncoder ?? null,
      },
    });
    if (applied.previousEncoders) {
      const latest = useAppStore.getState().showConfig;
      const previous = nextHardwarePreviousSnapshot(
        {
          pending: latest.hardwareEncoderPending === true,
          previous: {
            simple: latest.previousSimpleEncoder ?? null,
            adv: latest.previousAdvEncoder ?? null,
          },
        },
        applied.previousEncoders
      );
      useAppStore.getState().setShowConfig({
        hardwareEncoderPending: true,
        previousSimpleEncoder: previous.simple,
        previousAdvEncoder: previous.adv,
      });
    }
    if (applied.devices.video.length > 0 || applied.devices.audio.length > 0) {
      useAppStore.getState().setDeviceEnum({
        connected: true,
        video: applied.devices.video,
        audio: applied.devices.audio,
      });
    }
    if (applied.cameraMissing && cfg.camera) {
      useAppStore.getState().setSetupResumeMessage(missingCameraMessage(cfg.camera));
      return { cameraMissing: true };
    }
    return { cameraMissing: false };
  } catch {
    useAppStore.getState().setShowConfig({
      lastQualitySummary: "Couldn't test your upload — streaming at Steady.",
    });
    return { cameraMissing: false };
  } finally {
    useAppStore.getState().setQualityTesting(false);
  }
}
