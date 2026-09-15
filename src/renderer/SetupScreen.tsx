import { useEffect, useRef, useState } from "react";
import { persistableShowConfig, useAppStore } from "../state/store.js";
import {
  deviceDropdownPlaceholder,
  deviceEnumFromAttempt,
  deviceFieldLabel,
  selectDeviceChoice,
  setupDeviceBanner,
  SETUP_COPY_OBS_PASSWORD_HINT,
  SETUP_SHOW_TOOLS_HINT,
  SETUP_TRY_AGAIN,
  setupContinueAllowed,
} from "../state/setupDevices.js";
import type { DeviceChoice } from "../shared/types.js";
import { runAppFirstRun } from "../obs/runSetup.js";
import { RealObsClient, startObsSetupSession } from "../obs/client.js";
import type { ObsWebsocketConfig } from "../obs/obsConfig.js";
import { enumerateStudioDevices } from "../obs/devices.js";
import {
  applyShowExtras,
  deviceEnumForLaunch,
  EMPTY_SHOW_STORE,
  parseShowStore,
  resumePickedShow,
  serializeShowStore,
  sessionCredentials,
  showByName,
  snapshotShowExtras,
  upsertShow,
  type PersistedShow,
  type ShowStoreState,
} from "../state/showStore.js";

/** Setup screen: this IS the first-run wizard, per the brief — nothing
 * else is built as a separate flow. Three dropdowns, a show name, and a
 * copy-password button. Device lists come from OBS via
 * GetInputPropertiesListPropertyItems (never browser enumerateDevices). */
function loadSavedShowsNow(): ShowStoreState {
  try {
    const api = window.whatnotStudio;
    if (api && typeof api.loadShowStoreSync === "function") {
      return parseShowStore(api.loadShowStoreSync());
    }
  } catch {
    // missing bridge / malformed disk — first-run empty list
  }
  return EMPTY_SHOW_STORE;
}

export default function SetupScreen() {
  const showConfig = useAppStore((s) => s.showConfig);
  const setShowConfig = useAppStore((s) => s.setShowConfig);
  const goToLive = useAppStore((s) => s.goToLive);
  const deviceEnum = useAppStore((s) => s.deviceEnum);
  const setupResumeMessage = useAppStore((s) => s.setupResumeMessage);
  const setSetupResumeMessage = useAppStore((s) => s.setSetupResumeMessage);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ShowStoreState>(loadSavedShowsNow);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    const client = new RealObsClient();
    const session = startObsSetupSession({
      client,
      loadConfig: () =>
        window.whatnotStudio.readObsWebsocketConfig() as Promise<ObsWebsocketConfig>,
      enumerate: enumerateStudioDevices,
      onAttempt: (attempt) => {
        useAppStore.getState().setDeviceEnum(deviceEnumFromAttempt(attempt));
      },
      onCredentials: ({ port, password }) => {
        useAppStore.getState().setShowConfig({ obsPort: port, obsPassword: password });
      },
    });
    retryRef.current = () => session.retry();
    return () => {
      retryRef.current = () => {};
      session.stop();
    };
  }, []);

  useEffect(() => {
    if (typeof window.whatnotStudio?.loadShowStoreSync === "function") return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.whatnotStudio.loadShowStore();
        if (!cancelled) setSaved(parseShowStore(raw));
      } catch {
        if (!cancelled) setSaved(EMPTY_SHOW_STORE);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canContinue = setupContinueAllowed({
    showName: showConfig.showName,
    camera: showConfig.camera,
    starting,
    storedCameraMissing: setupResumeMessage !== null,
  });
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
        obsAlreadyRunning: deviceEnum.connected,
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
      const next = upsertShow(saved, persistableShowConfig(useAppStore.getState().showConfig), snapshotShowExtras(showConfig.showName));
      setSaved(next);
      try {
        await window.whatnotStudio.saveShowStore(serializeShowStore(next));
      } catch {
        // LIVE still opens; the next launch just will not have this show
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
    if (kind === "camera") setSetupResumeMessage(null);
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

  function pickSavedShow(name: string) {
    const show = showByName(saved, name);
    if (!show) return;
    const session = useAppStore.getState().showConfig;
    const obsConnected = deviceEnum.connected;
    const picked = resumePickedShow(
      saved,
      name,
      deviceEnumForLaunch(obsConnected, deviceEnum.video),
      obsConnected
    );
    if (!picked) return;
    applyShowExtras(show);
    setShowConfig(sessionCredentials(session, picked.decision.showConfig));
    setSetupResumeMessage(picked.decision.setupResumeMessage);
    setSaved(picked.next);
    void window.whatnotStudio.saveShowStore(serializeShowStore(picked.next)).catch(() => {});
    if (picked.goLive) goToLive();
  }

  function startNewShow() {
    const session = useAppStore.getState().showConfig;
    setShowConfig({
      showName: "",
      camera: null,
      mic: null,
      captureCard: null,
      obsPassword: session.obsPassword,
      obsPort: session.obsPort,
    });
    setSetupResumeMessage(null);
  }

  return (
    <div className="flex min-h-screen w-full flex-col gap-6 bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-2xl font-semibold">Whatnot Studio — Setup</h1>

      {setupResumeMessage && (
        <div className="rounded-md bg-amber-950 px-4 py-3 text-sm text-amber-200 ring-1 ring-amber-800">
          {setupResumeMessage}
        </div>
      )}

      <ShowPicker
        shows={saved.shows}
        lastUsedName={saved.lastUsedName}
        activeName={showConfig.showName}
        onPick={pickSavedShow}
        onStartNew={startNewShow}
      />

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

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <button
            className="rounded-md bg-neutral-800 px-4 py-3 text-sm hover:bg-neutral-700"
            onClick={() => void openShowTools()}
          >
            Open Whatnot Show Tools
          </button>
          <span className="text-sm text-neutral-500">{SETUP_SHOW_TOOLS_HINT}</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="rounded-md bg-neutral-800 px-4 py-3 text-sm hover:bg-neutral-700"
            onClick={() => void copyPassword()}
          >
            Copy OBS password
          </button>
          <span className="text-sm text-neutral-500">{SETUP_COPY_OBS_PASSWORD_HINT}</span>
        </div>
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

export function ShowPicker(props: {
  shows: PersistedShow[];
  lastUsedName: string | null;
  activeName: string;
  onPick: (name: string) => void;
  onStartNew: () => void;
}) {
  if (props.shows.length === 0) return null;
  const startingNew = props.activeName.trim() === "";
  return (
    <section className="flex flex-col gap-3" aria-label="Your shows">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-[0.18em] text-amber-500/90">Your shows</h2>
        <p className="text-sm text-neutral-500">Pick one to come back to it</p>
      </div>
      <ul className="flex flex-col gap-2">
        {props.shows.map((show) => {
          const selected = !startingNew && show.name === props.activeName.trim();
          const lastTime = show.name === props.lastUsedName;
          const camera = show.config.camera?.label ?? "No camera saved";
          return (
            <li key={show.name}>
              <button
                type="button"
                onClick={() => props.onPick(show.name)}
                className={`flex min-h-16 w-full items-center justify-between gap-3 rounded-md px-4 py-3 text-left ring-1 ${
                  selected
                    ? "bg-amber-500/15 ring-amber-500"
                    : "bg-neutral-900 ring-neutral-800 hover:bg-neutral-800"
                }`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-lg font-semibold">{show.name}</span>
                  <span className="truncate text-sm text-neutral-400">{camera}</span>
                </span>
                {lastTime ? (
                  <span className="shrink-0 rounded-sm bg-neutral-800 px-2 py-1 text-xs uppercase tracking-wide text-amber-200">
                    Last time
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={props.onStartNew}
        className={`min-h-16 rounded-md px-4 py-3 text-left text-base ring-1 ${
          startingNew
            ? "bg-amber-500/15 font-semibold text-neutral-100 ring-amber-500"
            : "bg-transparent text-neutral-400 ring-dashed ring-neutral-700 hover:text-neutral-200"
        }`}
      >
        Start a new show
      </button>
    </section>
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
