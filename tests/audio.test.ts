import { describe, it, expect } from "vitest";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";
import {
  applyAudioSettings,
  DESKTOP_INPUT_KIND,
  DESKTOP_INPUT_NAME,
  DEVICE_PROPERTY,
  EVENT_SUBSCRIPTION_ALL,
  EVENT_SUBSCRIPTION_INPUT_VOLUME_METERS,
  listMicrophones,
  parseInputVolumeMeters,
  selectMicrophone,
  setDesktopAudioEnabled,
  setMicrophoneMuted,
  silenceCompetingAudio,
  startAudioSession,
  VOICE_INPUT_KIND,
  VOICE_INPUT_NAME,
  type AudioSnapshot,
} from "../src/audio/index.js";
import { initialAudioSettings, type AudioSettings } from "../src/state/audio.js";

class FakeAudioClient extends FakeObsClient {
  reidentifyCalls: { eventSubscriptions: number }[] = [];

  async reidentify(data: { eventSubscriptions: number }): Promise<void> {
    this.reidentifyCalls.push(data);
  }
}

function callsOf(client: FakeObsClient, requestType: string) {
  return client.calls.filter((c) => c.requestType === requestType);
}

function makeAudioFake(opts?: {
  inputs?: { inputName: string; inputKind: string }[];
  muteReported?: boolean;
  echoMute?: boolean;
  devices?: { itemName: string; itemValue: string; itemEnabled: boolean }[];
}): {
  client: FakeAudioClient;
  inputs: { inputName: string; inputKind: string }[];
  devices: { itemName: string; itemValue: string; itemEnabled: boolean }[];
} {
  const inputs = [...(opts?.inputs ?? [{ inputName: VOICE_INPUT_NAME, inputKind: VOICE_INPUT_KIND }])];
  let muteReported = opts?.muteReported ?? false;
  let lastMute: boolean | undefined;
  const echoMute = opts?.echoMute ?? false;
  const devices = opts?.devices ?? [
    { itemName: "Headset Mic", itemValue: "headset-1", itemEnabled: true },
    { itemName: "Laptop Mic", itemValue: "laptop-1", itemEnabled: true },
  ];

  const client = new FakeAudioClient({
    GetInputList: () => ({ inputs: inputs.map((i) => ({ ...i })) }),
    GetCurrentProgramScene: { currentProgramSceneName: "ME" },
    GetSceneList: { scenes: [{ sceneName: "ME" }] },
    CreateInput: (data?: Record<string, unknown>) => {
      const inputName = String(data?.inputName ?? "");
      const inputKind = String(data?.inputKind ?? "");
      if (inputName && !inputs.some((i) => i.inputName === inputName)) {
        inputs.push({ inputName, inputKind });
      }
      return { sceneItemId: 11, inputUuid: "u" };
    },
    RemoveInput: (data?: Record<string, unknown>) => {
      const idx = inputs.findIndex((i) => i.inputName === data?.inputName);
      if (idx >= 0) inputs.splice(idx, 1);
      return {};
    },
    RemoveSceneItem: {},
    SetInputSettings: {},
    SetInputMute: (data?: Record<string, unknown>) => {
      lastMute = data?.inputMuted === true;
      return {};
    },
    GetInputMute: () => ({ inputMuted: echoMute ? (lastMute ?? muteReported) : muteReported }),
    SetInputVolume: {},
    GetInputPropertiesListPropertyItems: () => ({
      propertyItems: devices,
    }),
  });

  return { client, inputs, devices };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for audio session");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("selectMicrophone", () => {
  it("selects a different microphone with the exact OBS calls", async () => {
    const { client } = makeAudioFake();
    await selectMicrophone(client, "laptop-1");
    expect(client.calls).toEqual([
      { requestType: "GetInputList", requestData: undefined },
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: VOICE_INPUT_NAME,
          inputSettings: { [DEVICE_PROPERTY]: "laptop-1" },
        },
      },
    ]);
  });

  it("creates a detached voice input when OBS does not have one yet", async () => {
    const { client } = makeAudioFake({ inputs: [] });
    await selectMicrophone(client, "headset-1");
    expect(callsOf(client, "CreateInput")).toEqual([
      {
        requestType: "CreateInput",
        requestData: {
          sceneName: "ME",
          inputName: VOICE_INPUT_NAME,
          inputKind: VOICE_INPUT_KIND,
          inputSettings: {},
          sceneItemEnabled: false,
        },
      },
    ]);
    expect(callsOf(client, "RemoveSceneItem")).toEqual([
      { requestType: "RemoveSceneItem", requestData: { sceneName: "ME", sceneItemId: 11 } },
    ]);
    expect(callsOf(client, "SetInputSettings")).toEqual([
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: VOICE_INPUT_NAME,
          inputSettings: { [DEVICE_PROPERTY]: "headset-1" },
        },
      },
    ]);
  });
});

describe("mute", () => {
  it("mutes and unmutes using the value OBS reports, not the local argument", async () => {
    const { client } = makeAudioFake({ muteReported: false });
    const muted = await setMicrophoneMuted(client, true);
    expect(callsOf(client, "SetInputMute")).toEqual([
      { requestType: "SetInputMute", requestData: { inputName: VOICE_INPUT_NAME, inputMuted: true } },
    ]);
    expect(callsOf(client, "GetInputMute")).toEqual([
      { requestType: "GetInputMute", requestData: { inputName: VOICE_INPUT_NAME } },
    ]);
    expect(muted).toBe(false);

    client.calls = [];
    const { client: echoing } = makeAudioFake({ echoMute: true });
    const unmuted = await setMicrophoneMuted(echoing, false);
    expect(callsOf(echoing, "SetInputMute")[0]?.requestData).toEqual({
      inputName: VOICE_INPUT_NAME,
      inputMuted: false,
    });
    expect(unmuted).toBe(false);
  });
});

describe("desktop audio", () => {
  it("defaults off and does not create a desktop capture on apply", async () => {
    const { client } = makeAudioFake();
    const settings = initialAudioSettings();
    expect(settings.desktopAudioOn).toBe(false);
    await applyAudioSettings(client, settings);
    expect(callsOf(client, "CreateInput").filter((c) => c.requestData?.inputName === DESKTOP_INPUT_NAME)).toEqual([]);
    expect(callsOf(client, "RemoveInput")).toEqual([]);
  });

  it("adds and removes desktop audio cleanly", async () => {
    const { client, inputs } = makeAudioFake();
    await setDesktopAudioEnabled(client, true);
    expect(callsOf(client, "CreateInput")).toEqual([
      {
        requestType: "CreateInput",
        requestData: {
          sceneName: "ME",
          inputName: DESKTOP_INPUT_NAME,
          inputKind: DESKTOP_INPUT_KIND,
          inputSettings: {},
          sceneItemEnabled: false,
        },
      },
    ]);
    expect(callsOf(client, "RemoveSceneItem")).toHaveLength(1);
    expect(inputs.some((i) => i.inputName === DESKTOP_INPUT_NAME)).toBe(true);

    client.calls = [];
    await setDesktopAudioEnabled(client, false);
    expect(callsOf(client, "RemoveInput")).toEqual([
      { requestType: "RemoveInput", requestData: { inputName: DESKTOP_INPUT_NAME } },
    ]);
    expect(inputs.some((i) => i.inputName === DESKTOP_INPUT_NAME)).toBe(false);

    client.calls = [];
    await setDesktopAudioEnabled(client, false);
    expect(callsOf(client, "RemoveInput")).toEqual([]);
    expect(callsOf(client, "CreateInput")).toEqual([]);
  });
});

describe("listMicrophones", () => {
  it("keeps an unplugged selected device visible as gone", async () => {
    const { client } = makeAudioFake();
    const devices = await listMicrophones(client, { deviceId: "usb-gone", label: "USB Mic" });
    const gone = devices.find((d) => d.deviceId === "usb-gone");
    expect(gone).toEqual({ deviceId: "usb-gone", label: "USB Mic", gone: true });
    expect(devices.filter((d) => !d.gone).map((d) => d.label)).toEqual(["Headset Mic", "Laptop Mic"]);
  });
});

describe("silence competing captures", () => {
  it("mutes OBS default mic, desktop, and camera audio — not Whatnot Voice", async () => {
    const { client } = makeAudioFake({
      inputs: [
        { inputName: VOICE_INPUT_NAME, inputKind: VOICE_INPUT_KIND },
        { inputName: "Mic/Aux", inputKind: VOICE_INPUT_KIND },
        { inputName: "Desktop Audio", inputKind: DESKTOP_INPUT_KIND },
        { inputName: "Camera", inputKind: "dshow_input" },
        { inputName: "BREAK Card", inputKind: "text_gdiplus_v3" },
      ],
    });
    await silenceCompetingAudio(client);
    expect(callsOf(client, "SetInputMute")).toEqual([
      { requestType: "SetInputMute", requestData: { inputName: "Mic/Aux", inputMuted: true } },
      { requestType: "SetInputMute", requestData: { inputName: "Desktop Audio", inputMuted: true } },
      { requestType: "SetInputMute", requestData: { inputName: "Camera", inputMuted: true } },
    ]);
  });

  it("applyAudioSettings silences competing captures so mute cannot lie", async () => {
    const { client } = makeAudioFake({
      inputs: [
        { inputName: VOICE_INPUT_NAME, inputKind: VOICE_INPUT_KIND },
        { inputName: "Mic/Aux", inputKind: VOICE_INPUT_KIND },
      ],
      echoMute: true,
    });
    await applyAudioSettings(client, initialAudioSettings());
    expect(
      callsOf(client, "SetInputMute").filter((c) => c.requestData?.inputName === "Mic/Aux")
    ).toEqual([{ requestType: "SetInputMute", requestData: { inputName: "Mic/Aux", inputMuted: true } }]);
  });
});

describe("reconnect reapply", () => {
  it("reapplies settings after a reconnect", async () => {
    const { client } = makeAudioFake({ echoMute: true });
    const settings: AudioSettings = {
      ...initialAudioSettings(),
      micDeviceId: "headset-1",
      micLabel: "Headset Mic",
      micMuted: true,
      desktopAudioOn: true,
      micVolumeStep: "loud",
    };

    let snap: AudioSnapshot | null = null;
    const session = startAudioSession({
      client,
      url: "ws://127.0.0.1:4455",
      settings,
      onChange: (s) => {
        snap = s;
      },
    });
    await waitUntil(() => snap?.connected === true && (snap?.devices.length ?? 0) > 0);

    const firstApply = [...client.calls];
    expect(firstApply.some((c) => c.requestType === "SetInputSettings")).toBe(true);
    expect(firstApply.some((c) => c.requestType === "SetInputMute" && c.requestData?.inputMuted === true)).toBe(true);
    expect(firstApply.some((c) => c.requestType === "CreateInput" && c.requestData?.inputName === DESKTOP_INPUT_NAME)).toBe(
      true
    );

    client.calls = [];
    client.emit("ConnectionClosed");
    expect(session.getSnapshot().connected).toBe(false);

    session.retryNow();
    await waitUntil(() => session.getSnapshot().connected === true && session.getSnapshot().devices.length > 0);

    const reapplied = client.calls;
    expect(reapplied.filter((c) => c.requestType === "SetInputSettings")).toEqual([
      {
        requestType: "SetInputSettings",
        requestData: {
          inputName: VOICE_INPUT_NAME,
          inputSettings: { [DEVICE_PROPERTY]: "headset-1" },
        },
      },
    ]);
    expect(reapplied.some((c) => c.requestType === "SetInputMute" && c.requestData?.inputMuted === true)).toBe(true);
    expect(reapplied.some((c) => c.requestType === "SetInputVolume" && c.requestData?.inputVolumeMul === 1.5)).toBe(true);
    session.stop();
  });
});

describe("volume meters", () => {
  it("drops the volume-meter subscription when the panel unmounts", async () => {
    const { client } = makeAudioFake({ echoMute: true });
    const session = startAudioSession({
      client,
      url: "ws://127.0.0.1:4455",
      settings: initialAudioSettings(),
      onChange: () => {},
    });
    await waitUntil(() => session.getSnapshot().connected && session.getSnapshot().devices.length > 0);

    expect(client.reidentifyCalls.at(-1)?.eventSubscriptions).toBe(
      EVENT_SUBSCRIPTION_ALL | EVENT_SUBSCRIPTION_INPUT_VOLUME_METERS
    );

    client.emit("InputVolumeMeters", {
      inputs: [{ inputName: VOICE_INPUT_NAME, inputLevelsMul: [[0.1, 0.8, 0.9]] }],
    });
    expect(session.getSnapshot().levels[VOICE_INPUT_NAME]).toBe(0.8);

    session.stop();

    expect(client.reidentifyCalls.at(-1)?.eventSubscriptions).toBe(EVENT_SUBSCRIPTION_ALL);
    client.emit("InputVolumeMeters", {
      inputs: [{ inputName: VOICE_INPUT_NAME, inputLevelsMul: [[0.1, 1, 1]] }],
    });
    expect(session.getSnapshot().levels[VOICE_INPUT_NAME]).toBe(0.8);
  });

  it("parses InputVolumeMeters peaks", () => {
    expect(
      parseInputVolumeMeters({
        inputs: [
          { inputName: VOICE_INPUT_NAME, inputLevelsMul: [[0.2, 0.4, 0.5], [0.1, 0.7, 0.8]] },
        ],
      })
    ).toEqual({ [VOICE_INPUT_NAME]: 0.7 });
  });
});

describe("device list while connected", () => {
  it("marks the selected mic gone when it disappears mid-show, without reconnecting", async () => {
    const { client, devices } = makeAudioFake({ echoMute: true });
    const session = startAudioSession({
      client,
      url: "ws://127.0.0.1:4455",
      settings: {
        ...initialAudioSettings(),
        micDeviceId: "headset-1",
        micLabel: "Headset Mic",
      },
      onChange: () => {},
      devicePollMs: 20,
    });
    await waitUntil(() => session.getSnapshot().connected && session.getSnapshot().devices.length > 0);
    expect(session.getSnapshot().devices.some((d) => d.deviceId === "headset-1" && d.gone)).toBe(false);

    const idx = devices.findIndex((d) => d.itemValue === "headset-1");
    if (idx >= 0) devices.splice(idx, 1);

    await waitUntil(() => session.getSnapshot().devices.some((d) => d.deviceId === "headset-1" && d.gone));
    expect(session.getSnapshot().connected).toBe(true);
    expect(client.connectCalls).toBe(1);
    session.stop();
  });
});

describe("disconnected panel", () => {
  it("survives OBS disconnecting while the panel is open", async () => {
    const { client } = makeAudioFake({ echoMute: true });
    const session = startAudioSession({
      client,
      url: "ws://127.0.0.1:4455",
      settings: {
        ...initialAudioSettings(),
        micDeviceId: "headset-1",
        micLabel: "Headset Mic",
      },
      onChange: () => {},
    });
    await waitUntil(() => session.getSnapshot().connected && session.getSnapshot().devices.length > 0);

    const devicesBefore = session.getSnapshot().devices;
    client.emit("ConnectionClosed");
    expect(session.getSnapshot().connected).toBe(false);
    expect(session.getSnapshot().devices).toEqual(devicesBefore);

    client.calls = [];
    await expect(
      session.selectMicrophone({ deviceId: "laptop-1", label: "Laptop Mic" })
    ).resolves.toBeUndefined();
    expect(session.getSnapshot().settings.micDeviceId).toBe("laptop-1");
    expect(session.getSnapshot().connected).toBe(false);
    expect(client.calls).toEqual([]);

    await expect(session.setMuted(true)).resolves.toBeUndefined();
    expect(session.getSnapshot().settings.micMuted).toBe(true);
    session.stop();
  });
});
