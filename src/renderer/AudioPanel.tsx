import { useEffect, useRef, useState } from "react";
import { AudioObsClient, startAudioSession, VOICE_INPUT_NAME, DESKTOP_INPUT_NAME } from "../audio/index.js";
import type { ObsClient } from "../obs/client.js";
import {
  AUDIO_COPY,
  AUDIO_SETTINGS_KEY,
  deviceOptionLabel,
  loadAudioSettings,
  seedAudioSettings,
  VOLUME_STEPS,
  type AudioSettings,
} from "../state/audio.js";
import { useAppStore } from "../state/store.js";
import type { AudioSessionHandle, AudioSnapshot } from "../audio/session.js";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function LevelMeter(props: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
  return (
    <div className="flex items-center gap-2" aria-label={props.label}>
      <div className="h-3 flex-1 overflow-hidden rounded-sm bg-neutral-800 ring-1 ring-neutral-700">
        <div className="h-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AudioPanel(props: { client?: ObsClient }) {
  const showConfig = useAppStore((s) => s.showConfig);
  const setShowConfig = useAppStore((s) => s.setShowConfig);
  const setMicMuted = useAppStore((s) => s.setMicMuted);
  const obsPort = showConfig.obsPort;
  const obsPassword = showConfig.obsPassword;

  const [snap, setSnap] = useState<AudioSnapshot>(() => {
    const settings = seedAudioSettings(loadAudioSettings(browserStorage()), showConfig.mic);
    return { connected: false, settings, devices: [], levels: {} };
  });

  const sessionRef = useRef<AudioSessionHandle | null>(null);

  useEffect(() => {
    const storage = browserStorage();
    const settings: AudioSettings = seedAudioSettings(loadAudioSettings(storage), showConfig.mic);
    const client = props.client ?? new AudioObsClient();
    const session = startAudioSession({
      client,
      url: `ws://127.0.0.1:${obsPort}`,
      password: obsPassword,
      settings,
      storage,
      onChange: (next) => {
        setSnap(next);
        setMicMuted(next.settings.micMuted);
        if (next.settings.micDeviceId && next.settings.micLabel) {
          const mic = useAppStore.getState().showConfig.mic;
          if (mic?.deviceId !== next.settings.micDeviceId) {
            setShowConfig({
              mic: { deviceId: next.settings.micDeviceId, label: next.settings.micLabel },
            });
          }
        }
      },
    });
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.stop();
    };
    // showConfig.mic is the seed only; the session owns later changes.
  }, [obsPort, obsPassword, props.client, setMicMuted, setShowConfig]);

  const muted = snap.settings.micMuted;
  const selectedId = snap.settings.micDeviceId ?? "";
  const selectedGone = snap.devices.some((d) => d.deviceId === selectedId && d.gone);

  return (
    <section
      className={`flex flex-col gap-3 rounded-md p-3 ring-2 ${
        muted ? "bg-red-950 ring-red-500" : "bg-neutral-900 ring-neutral-800"
      }`}
      aria-label={AUDIO_COPY.title}
      data-audio-settings-key={AUDIO_SETTINGS_KEY}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{AUDIO_COPY.title}</h2>
        {muted ? (
          <span className="text-sm font-bold uppercase tracking-wide text-red-300">They cannot hear you</span>
        ) : null}
      </div>

      {!snap.connected ? (
        <p className="rounded-md bg-amber-950 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-800">
          {AUDIO_COPY.disconnected}
        </p>
      ) : null}

      <label className="flex flex-col gap-2">
        <span className="text-sm text-neutral-300">{AUDIO_COPY.yourMic}</span>
        <select
          className={`rounded-md bg-neutral-950 px-3 py-3 text-base outline-none ring-1 focus:ring-neutral-500 ${
            selectedGone ? "ring-amber-500 text-amber-200" : "ring-neutral-800"
          }`}
          value={selectedId}
          onChange={(e) => {
            const device = snap.devices.find((d) => d.deviceId === e.target.value);
            if (!device) return;
            setShowConfig({ mic: { deviceId: device.deviceId, label: device.label } });
            void sessionRef.current?.selectMicrophone({ deviceId: device.deviceId, label: device.label });
          }}
        >
          {snap.devices.length === 0 ? <option value="">No microphones found</option> : null}
          {snap.devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {deviceOptionLabel(d.label, d.gone)}
            </option>
          ))}
        </select>
        <LevelMeter value={snap.levels[VOICE_INPUT_NAME] ?? 0} label="Microphone level" />
      </label>

      <div className="flex gap-2">
        {VOLUME_STEPS.map((step) => (
          <button
            key={step.id}
            className={`h-12 flex-1 rounded-md text-sm font-semibold ${
              snap.settings.micVolumeStep === step.id
                ? "bg-amber-500 text-neutral-950"
                : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
            }`}
            onClick={() => void sessionRef.current?.setMicVolume(step.id)}
          >
            {step.label}
          </button>
        ))}
      </div>

      <button
        className={`flex min-h-20 w-full items-center justify-center rounded-md px-3 text-2xl font-bold ${
          muted ? "bg-red-600 text-white ring-4 ring-red-300" : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        }`}
        onClick={() => void sessionRef.current?.setMuted(!muted)}
      >
        {muted ? AUDIO_COPY.muted : AUDIO_COPY.mute}
      </button>

      <label className="flex items-center gap-3 rounded-md bg-neutral-950 px-3 py-3 text-base">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={snap.settings.desktopAudioOn}
          onChange={(e) => void sessionRef.current?.setDesktopAudio(e.target.checked)}
        />
        <span>{AUDIO_COPY.desktop}</span>
      </label>

      {snap.settings.desktopAudioOn ? (
        <div className="flex flex-col gap-2">
          <LevelMeter value={snap.levels[DESKTOP_INPUT_NAME] ?? 0} label="Computer sound level" />
          <div className="flex gap-2">
            {VOLUME_STEPS.map((step) => (
              <button
                key={step.id}
                className={`h-12 flex-1 rounded-md text-sm font-semibold ${
                  snap.settings.desktopVolumeStep === step.id
                    ? "bg-amber-500 text-neutral-950"
                    : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
                }`}
                onClick={() => void sessionRef.current?.setDesktopVolume(step.id)}
              >
                {step.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
