import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/store.js";
import {
  deviceDropdownPlaceholder,
  deviceFieldLabel,
  selectDeviceChoice,
  setupDeviceBanner,
  SETUP_TRY_AGAIN,
} from "../state/setupDevices.js";
import type { DeviceChoice } from "../shared/types.js";
import { runAppFirstRun } from "../obs/runSetup.js";
import { RealObsClient } from "../obs/client.js";
import { startSetupDeviceSession } from "../obs/devices.js";

/** Setup screen: this IS the first-run wizard, per the brief — nothing
 * else is built as a separate flow. Three dropdowns, a show name, and a
 * copy-password button. Device lists come from OBS via
 * GetInputPropertiesListPropertyItems (never browser enumerateDevices). */
export default function SetupScreen() {
  const showConfig = useAppStore((s) => s.showConfig);
  const setShowConfig = useAppStore((s) => s.setShowConfig);
  const goToLive = useAppStore((s) => s.goToLive);
  const deviceEnum = useAppStore((s) => s.deviceEnum);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    const client = new RealObsClient();
    const session = startSetupDeviceSession({
      client,
      url: `ws://127.0.0.1:${showConfig.obsPort}`,
      password: showConfig.obsPassword,
    });
    retryRef.current = () => session.retry();
    return () => {
      retryRef.current = () => {};
      session.stop();
    };
  }, [showConfig.obsPort, showConfig.obsPassword]);

  const canContinue = showConfig.showName.trim() !== "" && showConfig.camera !== null && !starting;
  const banner = setupDeviceBanner(deviceEnum);
  const videoDevices = deviceEnum.video;
  const audioDevices = deviceEnum.audio;

  async function handleContinue() {
    setStarting(true);
    setSetupError(null);
    try {
      const result = await runAppFirstRun({
        bridge: window.whatnotStudio,
        port: showConfig.obsPort,
        password: showConfig.obsPassword,
        makeObsClient: () => new RealObsClient(),
      });
      if (!result.ok) {
        setSetupError(result.reason ?? "First-run setup failed for an unknown reason.");
        return;
      }
      if (result.versionWarning) {
        // Non-blocking: still proceed, just surface the warning.
        setSetupError(result.versionWarning);
      }
      goToLive();
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  function pickDevice(kind: "camera" | "mic" | "captureCard", deviceId: string) {
    const list = kind === "mic" ? audioDevices : videoDevices;
    const choice = selectDeviceChoice(list, deviceId);
    setShowConfig({ [kind]: choice } as Partial<typeof showConfig>);
  }

  async function copyPassword() {
    await window.whatnotStudio.copyToClipboard(showConfig.obsPassword);
  }

  async function openShowTools() {
    // MEASURED by HQ 2026-09-15 (whatnot-show-tools-measured.md), through
    // Khan's own signed-in Chrome: the real Show Tools URL is
    // /dashboard/lives/setup. The earlier /dashboard/livestream/setup guess
    // 404s.
    await window.whatnotStudio.openInChrome("https://www.whatnot.com/dashboard/lives/setup");
  }

  return (
    <div className="flex min-h-screen w-full flex-col gap-6 bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-2xl font-semibold">Whatnot Studio — Setup</h1>

      {banner && (
        <div className="flex flex-col gap-3 rounded-md bg-neutral-900 px-4 py-4 ring-1 ring-neutral-800">
          <p className="text-base">{banner.title}</p>
          {banner.body && <p className="text-sm text-neutral-400">{banner.body}</p>}
        </div>
      )}

      <button
        className="w-fit rounded-md bg-neutral-800 px-4 py-3 text-sm hover:bg-neutral-700"
        onClick={() => retryRef.current()}
      >
        {SETUP_TRY_AGAIN}
      </button>

      <label className="flex flex-col gap-2">
        <span className="text-sm text-neutral-400">Show name</span>
        <input
          className="rounded-md bg-neutral-900 px-4 py-3 text-lg outline-none ring-1 ring-neutral-800 focus:ring-neutral-500"
          value={showConfig.showName}
          onChange={(e) => setShowConfig({ showName: e.target.value })}
          placeholder="Saturday Night Vintage"
        />
      </label>

      <DeviceDropdown
        label={deviceFieldLabel("Camera")}
        devices={videoDevices}
        value={showConfig.camera}
        placeholder={deviceDropdownPlaceholder(deviceEnum.connected, "camera", videoDevices.length)}
        disabled={!deviceEnum.connected}
        onChange={(id) => pickDevice("camera", id)}
      />
      <DeviceDropdown
        label={deviceFieldLabel("Microphone")}
        devices={audioDevices}
        value={showConfig.mic}
        placeholder={deviceDropdownPlaceholder(deviceEnum.connected, "mic", audioDevices.length)}
        disabled={!deviceEnum.connected}
        onChange={(id) => pickDevice("mic", id)}
      />
      <DeviceDropdown
        label={deviceFieldLabel("Capture card", true)}
        devices={videoDevices}
        value={showConfig.captureCard}
        placeholder={deviceDropdownPlaceholder(deviceEnum.connected, "captureCard", videoDevices.length)}
        disabled={!deviceEnum.connected}
        onChange={(id) => pickDevice("captureCard", id)}
      />

      <div className="flex items-center gap-3">
        <button
          className="rounded-md bg-neutral-800 px-4 py-3 text-sm hover:bg-neutral-700"
          onClick={() => void openShowTools()}
        >
          Open Whatnot Show Tools
        </button>
        <button
          className="rounded-md bg-neutral-800 px-4 py-3 text-sm hover:bg-neutral-700"
          onClick={() => void copyPassword()}
        >
          Copy OBS password
        </button>
        <span className="text-sm text-neutral-500">Paste it into Whatnot's Show Tools page.</span>
      </div>

      {setupError && (
        <div className="rounded-md bg-amber-950 px-4 py-3 text-sm text-amber-300 ring-1 ring-amber-800">
          {setupError}
        </div>
      )}

      <button
        className="mt-4 h-16 rounded-md bg-amber-500 text-lg font-semibold text-neutral-950 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
        disabled={!canContinue}
        onClick={() => void handleContinue()}
      >
        {starting ? "Setting up OBS…" : "Continue"}
      </button>
    </div>
  );
}

function DeviceDropdown(props: {
  label: string;
  devices: DeviceChoice[];
  value: DeviceChoice | null;
  placeholder: string;
  disabled?: boolean;
  onChange: (deviceId: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm text-neutral-400">{props.label}</span>
      <div className="flex items-center gap-3">
        <select
          className="flex-1 rounded-md bg-neutral-900 px-4 py-3 text-base outline-none ring-1 ring-neutral-800 focus:ring-neutral-500 disabled:text-neutral-500"
          value={props.value?.deviceId ?? ""}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">{props.placeholder}</option>
          {props.devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="h-12 w-20 shrink-0 rounded bg-neutral-900 ring-1 ring-neutral-800" aria-hidden />
      </div>
    </label>
  );
}
