import { useState } from "react";
import { useAppStore } from "../state/store.js";
import type { DeviceChoice } from "../shared/types.js";
import { runAppFirstRun } from "../obs/runSetup.js";
import { RealObsClient } from "../obs/client.js";

/** Setup screen: this IS the first-run wizard, per the brief — nothing
 * else is built as a separate flow. Three dropdowns, a show name, and a
 * copy-password button. Device enumeration and live thumbnails both need
 * a running OBS to populate (GetInputPropertiesListPropertyItems /
 * GetSourceScreenshot) — see HANDOVER.md. This screen renders correctly
 * with an empty device list so it is still buildable and testable
 * end-to-end for layout without OBS. */
export default function SetupScreen() {
  const showConfig = useAppStore((s) => s.showConfig);
  const setShowConfig = useAppStore((s) => s.setShowConfig);
  const goToLive = useAppStore((s) => s.goToLive);

  // Populated by src/obs (device enumeration) once connected to OBS — see
  // HANDOVER.md. Empty here is a correct, renderable state, not a bug.
  const [devices] = useState<DeviceChoice[]>([]);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const canContinue = showConfig.showName.trim() !== "" && showConfig.camera !== null && !starting;

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
    const choice = devices.find((d) => d.deviceId === deviceId) ?? null;
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
        label="Camera"
        devices={devices}
        value={showConfig.camera}
        onChange={(id) => pickDevice("camera", id)}
      />
      <DeviceDropdown
        label="Microphone"
        devices={devices}
        value={showConfig.mic}
        onChange={(id) => pickDevice("mic", id)}
      />
      <DeviceDropdown
        label="Capture card (optional)"
        devices={devices}
        value={showConfig.captureCard}
        onChange={(id) => pickDevice("captureCard", id)}
        optional
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
  onChange: (deviceId: string) => void;
  optional?: boolean;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm text-neutral-400">
        {props.label}
        {props.optional ? " (optional)" : ""}
      </span>
      <div className="flex items-center gap-3">
        <select
          className="flex-1 rounded-md bg-neutral-900 px-4 py-3 text-base outline-none ring-1 ring-neutral-800 focus:ring-neutral-500"
          value={props.value?.deviceId ?? ""}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">{props.devices.length === 0 ? "No devices detected" : "Select…"}</option>
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
