/**
 * Enumerate cameras, capture cards and microphones the way OBS itself
 * names them. The Setup screen stores whatever `itemValue` OBS returns
 * on `GetInputPropertiesListPropertyItems` and later writes it into a
 * `dshow_input`'s `video_device_id` (and the matching audio property).
 *
 * Browser `enumerateDevices()` IDs and PowerShell/WMI names are the
 * wrong IDs — they are not what OBS stores. This module never uses them.
 */
import type { ObsClient } from "./client.js";
import type { DeviceChoice } from "../shared/types.js";
import { useAppStore } from "../state/store.js";

export const DSHOW_INPUT_KIND = "dshow_input";
export const VIDEO_DEVICE_PROPERTY = "video_device_id";
export const AUDIO_DEVICE_PROPERTY = "audio_device_id";
export const DEVICE_PROBE_INPUT_NAME = "Whatnot Studio Device Probe";

export interface EnumeratedDevices {
  video: DeviceChoice[];
  audio: DeviceChoice[];
}

interface PropertyListItem {
  itemName?: unknown;
  itemValue?: unknown;
  itemEnabled?: unknown;
}

interface GetInputPropertiesListPropertyItemsResponse {
  propertyItems?: PropertyListItem[];
}

interface GetInputListResponse {
  inputs?: { inputName: string; inputKind: string }[];
}

interface GetSceneListResponse {
  currentProgramSceneName?: string;
  scenes?: { sceneName: string }[];
}

function mapPropertyItems(items: PropertyListItem[] | undefined): DeviceChoice[] {
  if (!items) return [];
  const out: DeviceChoice[] = [];
  for (const item of items) {
    if (item.itemEnabled === false) continue;
    const deviceId = item.itemValue;
    // IDs are stored exactly as OBS reported them. Non-strings are skipped
    // rather than coerced, so we never invent a different ID.
    if (typeof deviceId !== "string" || deviceId === "") continue;
    const label = typeof item.itemName === "string" && item.itemName !== "" ? item.itemName : deviceId;
    out.push({ deviceId, label });
  }
  return out;
}

/** List one properties-list on an existing OBS input. */
export async function listInputPropertyDevices(
  client: ObsClient,
  inputName: string,
  propertyName: string
): Promise<DeviceChoice[]> {
  const res = await client.call<GetInputPropertiesListPropertyItemsResponse>(
    "GetInputPropertiesListPropertyItems",
    { inputName, propertyName }
  );
  return mapPropertyItems(res.propertyItems);
}

async function ensureDshowInput(client: ObsClient): Promise<{ name: string; created: boolean }> {
  const list = await client.call<GetInputListResponse>("GetInputList");
  const inputs = list.inputs ?? [];
  const existing =
    inputs.find((i) => i.inputKind === DSHOW_INPUT_KIND && i.inputName !== DEVICE_PROBE_INPUT_NAME) ??
    inputs.find((i) => i.inputKind === DSHOW_INPUT_KIND);
  if (existing) {
    return { name: existing.inputName, created: existing.inputName === DEVICE_PROBE_INPUT_NAME };
  }

  const scenes = await client.call<GetSceneListResponse>("GetSceneList");
  const sceneName = scenes.currentProgramSceneName ?? scenes.scenes?.[0]?.sceneName;
  if (!sceneName) {
    throw new Error("OBS has no scene to attach a device probe to");
  }
  await client.call("CreateInput", {
    sceneName,
    inputName: DEVICE_PROBE_INPUT_NAME,
    inputKind: DSHOW_INPUT_KIND,
    sceneItemEnabled: false,
  });
  return { name: DEVICE_PROBE_INPUT_NAME, created: true };
}

/**
 * Ask OBS for the DirectShow video and audio device lists. Creates a
 * temporary `dshow_input` when the collection has none, and removes it
 * afterwards. Reuses an existing `dshow_input` when one is already there.
 */
export async function enumerateStudioDevices(client: ObsClient): Promise<EnumeratedDevices> {
  const probe = await ensureDshowInput(client);
  try {
    const video = await listInputPropertyDevices(client, probe.name, VIDEO_DEVICE_PROPERTY);
    const audio = await listInputPropertyDevices(client, probe.name, AUDIO_DEVICE_PROPERTY);
    return { video, audio };
  } finally {
    if (probe.created) {
      try {
        await client.call("RemoveInput", { inputName: probe.name });
      } catch {
        // Probe leftover is harmless; next run will reuse or recreate it.
      }
    }
  }
}

function applyDisconnected(): void {
  useAppStore.getState().setDeviceEnum({ connected: false, video: [], audio: [] });
}

function applyEnumerated(devices: EnumeratedDevices): void {
  useAppStore.getState().setDeviceEnum({
    connected: true,
    video: devices.video,
    audio: devices.audio,
  });
}

/**
 * Connect to OBS, enumerate devices into the store, and do it again on
 * retry or after a drop. The Setup screen owns the lifetime of this
 * session (one RealObsClient, stopped on unmount).
 */
export function startSetupDeviceSession(opts: {
  client: ObsClient;
  url: string;
  password?: string;
}): { stop: () => void; retry: () => void } {
  const { client, url, password } = opts;
  let cancelled = false;
  let inFlight = false;
  let generation = 0;

  const onClosed = () => {
    if (cancelled) return;
    applyDisconnected();
  };

  async function connectAndEnumerate() {
    if (cancelled || inFlight) return;
    inFlight = true;
    const my = ++generation;
    client.off("ConnectionClosed", onClosed);
    try {
      try {
        await client.disconnect();
      } catch {
        // already closed
      }
      if (cancelled || my !== generation) return;
      await client.connect(url, password);
      if (cancelled || my !== generation) {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
        return;
      }
      client.on("ConnectionClosed", onClosed);
      let devices: EnumeratedDevices = { video: [], audio: [] };
      try {
        devices = await enumerateStudioDevices(client);
      } catch {
        // Connected, but OBS had nothing we could list. That is the
        // "no cameras found" state, not a connection failure.
        devices = { video: [], audio: [] };
      }
      if (cancelled || my !== generation) return;
      applyEnumerated(devices);
    } catch {
      if (cancelled || my !== generation) return;
      applyDisconnected();
    } finally {
      inFlight = false;
    }
  }

  void connectAndEnumerate();

  return {
    stop: () => {
      cancelled = true;
      generation += 1;
      client.off("ConnectionClosed", onClosed);
      applyDisconnected();
      void client.disconnect();
    },
    retry: () => {
      void connectAndEnumerate();
    },
  };
}
