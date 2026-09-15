/**
 * OBS calls for the audio panel. Audio inputs are mixer sources, not
 * scene items — CreateInput still requires a scene, so we immediately
 * RemoveSceneItem and leave the input on the mixer only.
 */
import type { DeviceChoice } from "../shared/types.js";
import type { ObsClient } from "../obs/client.js";
import { volumeMul, type AudioSettings, type VolumeStepId } from "../state/audio.js";
import {
  DESKTOP_INPUT_KIND,
  DESKTOP_INPUT_NAME,
  DEVICE_PROPERTY,
  VOICE_INPUT_KIND,
  VOICE_INPUT_NAME,
} from "./constants.js";

export interface GetInputListResponse {
  inputs: { inputName: string; inputKind: string }[];
}

export interface AudioDevice {
  deviceId: string;
  label: string;
  gone: boolean;
}

async function resolveSceneName(obs: ObsClient): Promise<string> {
  try {
    const cur = await obs.call<{ currentProgramSceneName?: string }>("GetCurrentProgramScene");
    if (cur.currentProgramSceneName) return cur.currentProgramSceneName;
  } catch {
    // fall through to the scene list
  }
  const list = await obs.call<{ scenes: { sceneName: string }[] }>("GetSceneList");
  const name = list.scenes[0]?.sceneName;
  if (!name) throw new Error("No scene available to attach audio");
  return name;
}

async function createDetachedInput(
  obs: ObsClient,
  inputName: string,
  inputKind: string,
  inputSettings: Record<string, unknown>
): Promise<void> {
  const sceneName = await resolveSceneName(obs);
  const created = await obs.call<{ sceneItemId?: number }>("CreateInput", {
    sceneName,
    inputName,
    inputKind,
    inputSettings,
    sceneItemEnabled: false,
  });
  if (typeof created.sceneItemId === "number") {
    await obs.call("RemoveSceneItem", { sceneName, sceneItemId: created.sceneItemId });
  }
}

async function inputExists(obs: ObsClient, name: string): Promise<boolean> {
  const list = await obs.call<GetInputListResponse>("GetInputList");
  return list.inputs.some((i) => i.inputName === name);
}

export async function ensureVoiceInput(obs: ObsClient): Promise<void> {
  if (await inputExists(obs, VOICE_INPUT_NAME)) return;
  await createDetachedInput(obs, VOICE_INPUT_NAME, VOICE_INPUT_KIND, {});
}

export async function selectMicrophone(obs: ObsClient, deviceId: string): Promise<void> {
  await ensureVoiceInput(obs);
  await obs.call("SetInputSettings", {
    inputName: VOICE_INPUT_NAME,
    inputSettings: { [DEVICE_PROPERTY]: deviceId },
  });
}

/** Set mute, then read it back. The returned value is OBS's, never the
 * argument we just sent. */
export async function setMicrophoneMuted(obs: ObsClient, muted: boolean): Promise<boolean> {
  await obs.call("SetInputMute", { inputName: VOICE_INPUT_NAME, inputMuted: muted });
  const result = await obs.call<{ inputMuted: boolean }>("GetInputMute", { inputName: VOICE_INPUT_NAME });
  return result.inputMuted === true;
}

export async function setDesktopAudioEnabled(obs: ObsClient, on: boolean): Promise<void> {
  const exists = await inputExists(obs, DESKTOP_INPUT_NAME);
  if (on) {
    if (!exists) await createDetachedInput(obs, DESKTOP_INPUT_NAME, DESKTOP_INPUT_KIND, {});
    return;
  }
  if (exists) {
    await obs.call("RemoveInput", { inputName: DESKTOP_INPUT_NAME });
  }
}

export async function setInputVolumeStep(obs: ObsClient, inputName: string, step: VolumeStepId): Promise<void> {
  await obs.call("SetInputVolume", { inputName, inputVolumeMul: volumeMul(step) });
}

export async function listMicrophones(
  obs: ObsClient,
  selected: DeviceChoice | null
): Promise<AudioDevice[]> {
  await ensureVoiceInput(obs);
  const props = await obs.call<{
    propertyItems: { itemName?: string; itemValue?: unknown; itemEnabled?: boolean }[];
  }>("GetInputPropertiesListPropertyItems", {
    inputName: VOICE_INPUT_NAME,
    propertyName: DEVICE_PROPERTY,
  });

  const devices: AudioDevice[] = [];
  const seen = new Set<string>();
  for (const item of props.propertyItems ?? []) {
    if (item.itemEnabled === false) continue;
    if (item.itemValue === undefined || item.itemValue === null || item.itemValue === "") continue;
    const deviceId = String(item.itemValue);
    if (seen.has(deviceId)) continue;
    seen.add(deviceId);
    devices.push({
      deviceId,
      label: typeof item.itemName === "string" && item.itemName.trim() !== "" ? item.itemName : deviceId,
      gone: false,
    });
  }

  if (selected && !seen.has(selected.deviceId)) {
    devices.push({ deviceId: selected.deviceId, label: selected.label, gone: true });
  }
  return devices;
}

/** Kinds that can put sound on the stream besides our owned inputs. */
const COMPETING_AUDIO_KINDS = new Set([
  VOICE_INPUT_KIND,
  DESKTOP_INPUT_KIND,
  "wasapi_process_output_capture",
  "dshow_input",
]);

/**
 * Mute every capture that is not Whatnot Voice / Whatnot Computer.
 * Setup never created a mic source, but OBS still ships Mic/Aux and
 * webcam audio — mute/volume on Whatnot Voice would otherwise leave
 * those live.
 */
export async function silenceCompetingAudio(obs: ObsClient): Promise<void> {
  const list = await obs.call<GetInputListResponse>("GetInputList");
  const keep = new Set([VOICE_INPUT_NAME, DESKTOP_INPUT_NAME]);
  for (const input of list.inputs) {
    if (keep.has(input.inputName)) continue;
    if (!COMPETING_AUDIO_KINDS.has(input.inputKind)) continue;
    try {
      await obs.call("SetInputMute", { inputName: input.inputName, inputMuted: true });
    } catch {
      // source gone between list and mute
    }
  }
}

export async function applyAudioSettings(
  obs: ObsClient,
  settings: AudioSettings
): Promise<{ micMuted: boolean }> {
  const list = await obs.call<GetInputListResponse>("GetInputList");
  const names = new Set(list.inputs.map((i) => i.inputName));

  if (!names.has(VOICE_INPUT_NAME)) {
    await createDetachedInput(
      obs,
      VOICE_INPUT_NAME,
      VOICE_INPUT_KIND,
      settings.micDeviceId ? { [DEVICE_PROPERTY]: settings.micDeviceId } : {}
    );
  } else if (settings.micDeviceId) {
    await obs.call("SetInputSettings", {
      inputName: VOICE_INPUT_NAME,
      inputSettings: { [DEVICE_PROPERTY]: settings.micDeviceId },
    });
  }

  await obs.call("SetInputMute", { inputName: VOICE_INPUT_NAME, inputMuted: settings.micMuted });
  const mute = await obs.call<{ inputMuted: boolean }>("GetInputMute", { inputName: VOICE_INPUT_NAME });

  await obs.call("SetInputVolume", {
    inputName: VOICE_INPUT_NAME,
    inputVolumeMul: volumeMul(settings.micVolumeStep),
  });

  if (settings.desktopAudioOn) {
    if (!names.has(DESKTOP_INPUT_NAME)) {
      await createDetachedInput(obs, DESKTOP_INPUT_NAME, DESKTOP_INPUT_KIND, {});
    }
    await obs.call("SetInputVolume", {
      inputName: DESKTOP_INPUT_NAME,
      inputVolumeMul: volumeMul(settings.desktopVolumeStep),
    });
  } else if (names.has(DESKTOP_INPUT_NAME)) {
    await obs.call("RemoveInput", { inputName: DESKTOP_INPUT_NAME });
  }

  await silenceCompetingAudio(obs);

  return { micMuted: mute.inputMuted === true };
}
