/**
 * Live audio session: connect, apply persisted settings, queue changes
 * while disconnected, reapply on reconnect, drop meter subscription on stop.
 */
import type { DeviceChoice } from "../shared/types.js";
import type { ObsClient } from "../obs/client.js";
import {
  audioReducer,
  persistAudioSettings,
  type AudioSettings,
  type StorageLike,
  type VolumeStepId,
} from "../state/audio.js";
import {
  applyAudioSettings,
  listMicrophones,
  selectMicrophone,
  setDesktopAudioEnabled,
  setInputVolumeStep,
  setMicrophoneMuted,
  type AudioDevice,
} from "./obs.js";
import { parseInputVolumeMeters, subscribeInputVolumeMeters, type AudioObs } from "./meters.js";
import { DESKTOP_INPUT_NAME, VOICE_INPUT_NAME } from "./constants.js";

export const AUDIO_RETRY_MS = 2000;
/** Re-read the WASAPI device list while connected so an unplug mid-show
 * shows as gone without waiting for a reconnect. */
export const DEVICE_POLL_MS = 2000;

export interface AudioSnapshot {
  connected: boolean;
  settings: AudioSettings;
  devices: AudioDevice[];
  levels: Record<string, number>;
}

export interface AudioSessionHandle {
  stop(): void;
  retryNow(): void;
  selectMicrophone(device: DeviceChoice): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setDesktopAudio(on: boolean): Promise<void>;
  setMicVolume(step: VolumeStepId): Promise<void>;
  setDesktopVolume(step: VolumeStepId): Promise<void>;
  getSnapshot(): AudioSnapshot;
}

export function startAudioSession(opts: {
  client: ObsClient;
  url: string;
  password?: string;
  settings: AudioSettings;
  onChange: (snapshot: AudioSnapshot) => void;
  storage?: StorageLike | null;
  retryMs?: number;
  devicePollMs?: number;
}): AudioSessionHandle {
  const {
    client,
    url,
    password,
    onChange,
    storage = null,
    retryMs = AUDIO_RETRY_MS,
    devicePollMs = DEVICE_POLL_MS,
  } = opts;
  const audioClient = client as AudioObs;

  let cancelled = false;
  let connectEpoch = 0;
  let connected = false;
  let settings = opts.settings;
  let devices: AudioDevice[] = [];
  let levels: Record<string, number> = {};
  let unsubscribeMeters = () => {};
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function snapshot(): AudioSnapshot {
    return { connected, settings, devices, levels };
  }

  function emit() {
    onChange(snapshot());
  }

  function save(next: AudioSettings) {
    settings = next;
    persistAudioSettings(settings, storage);
    emit();
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (cancelled) return;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connectAndApply();
    }, retryMs);
  }

  function dropMeters() {
    unsubscribeMeters();
    unsubscribeMeters = () => {};
  }

  function stopDevicePoll() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startDevicePoll() {
    stopDevicePoll();
    if (devicePollMs <= 0) return;
    pollTimer = setInterval(() => {
      void pollDevices();
    }, devicePollMs);
  }

  async function pollDevices() {
    if (cancelled || !connected) return;
    try {
      const before = JSON.stringify(devices);
      await refreshDevices();
      if (JSON.stringify(devices) !== before) emit();
    } catch {
      // keep the last known list; gone-state is worse than a thrown panel
    }
  }

  const onMeters = (data: unknown) => {
    levels = parseInputVolumeMeters(data);
    emit();
  };

  const onClosed = () => {
    if (cancelled) return;
    connectEpoch += 1;
    connected = false;
    stopDevicePoll();
    dropMeters();
    emit();
    scheduleRetry();
  };

  async function runConnected<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (!connected) return undefined;
    try {
      return await work();
    } catch {
      connected = false;
      stopDevicePoll();
      emit();
      return undefined;
    }
  }

  async function refreshDevices() {
    const selected =
      settings.micDeviceId && settings.micLabel
        ? { deviceId: settings.micDeviceId, label: settings.micLabel }
        : null;
    devices = await listMicrophones(audioClient, selected);
  }

  async function connectAndApply() {
    if (cancelled) return;
    const epoch = ++connectEpoch;
    clearRetry();
    stopDevicePoll();
    try {
      try {
        await audioClient.disconnect();
      } catch {
        // already closed
      }
      if (cancelled || epoch !== connectEpoch) return;
      audioClient.off("ConnectionClosed", onClosed);
      dropMeters();
      await audioClient.connect(url, password);
      if (cancelled || epoch !== connectEpoch) {
        await audioClient.disconnect();
        return;
      }
      audioClient.on("ConnectionClosed", onClosed);
      unsubscribeMeters = subscribeInputVolumeMeters(audioClient, onMeters);
      const reported = await applyAudioSettings(audioClient, settings);
      if (cancelled || epoch !== connectEpoch) return;
      settings = { ...settings, micMuted: reported.micMuted };
      persistAudioSettings(settings, storage);
      await refreshDevices();
      if (cancelled || epoch !== connectEpoch) return;
      connected = true;
      startDevicePoll();
      emit();
    } catch {
      if (cancelled || epoch !== connectEpoch) return;
      connected = false;
      stopDevicePoll();
      emit();
      scheduleRetry();
    }
  }

  void connectAndApply();

  return {
    stop() {
      cancelled = true;
      clearRetry();
      stopDevicePoll();
      dropMeters();
      audioClient.off("ConnectionClosed", onClosed);
      void audioClient.disconnect();
      connected = false;
    },
    retryNow() {
      clearRetry();
      void connectAndApply();
    },
    getSnapshot: snapshot,
    async selectMicrophone(device: DeviceChoice) {
      save(audioReducer(settings, { type: "SELECT_MIC", deviceId: device.deviceId, label: device.label }));
      await runConnected(async () => {
        await selectMicrophone(audioClient, device.deviceId);
        await refreshDevices();
      });
      emit();
    },
    async setMuted(muted: boolean) {
      // Optimistic UI so the button flips immediately; OBS report overwrites.
      save(audioReducer(settings, { type: "SET_MUTED", muted }));
      const reported = await runConnected(() => setMicrophoneMuted(audioClient, muted));
      if (reported !== undefined) {
        save(audioReducer(settings, { type: "SET_MUTED", muted: reported }));
      }
    },
    async setDesktopAudio(on: boolean) {
      save(audioReducer(settings, { type: "SET_DESKTOP_AUDIO", on }));
      await runConnected(() => setDesktopAudioEnabled(audioClient, on));
    },
    async setMicVolume(step: VolumeStepId) {
      save(audioReducer(settings, { type: "SET_MIC_VOLUME", step }));
      await runConnected(() => setInputVolumeStep(audioClient, VOICE_INPUT_NAME, step));
    },
    async setDesktopVolume(step: VolumeStepId) {
      save(audioReducer(settings, { type: "SET_DESKTOP_VOLUME", step }));
      await runConnected(() => setInputVolumeStep(audioClient, DESKTOP_INPUT_NAME, step));
    },
  };
}
