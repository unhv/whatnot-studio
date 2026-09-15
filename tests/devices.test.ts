import { describe, it, expect, beforeEach } from "vitest";
import {
  AUDIO_DEVICE_PROPERTY,
  DEVICE_PROBE_INPUT_NAME,
  DSHOW_INPUT_KIND,
  VIDEO_DEVICE_PROPERTY,
  enumerateStudioDevices,
  listInputPropertyDevices,
  startSetupDeviceSession,
} from "../src/obs/devices.js";
import { DEFAULT_SHOW_CONFIG, useAppStore } from "../src/state/store.js";
import { initialDeviceEnum, selectDeviceChoice } from "../src/state/setupDevices.js";
import { FakeObsClient } from "./testUtils/fakeObsClient.js";

const OBS_CAMERA_ID = "\\\\?\\usb#vid_046d&pid_082d#exact-obs-id";
const OBS_MIC_ID = "{0.0.1.00000000}.{exact-wasapi-id}";

function propertyItemsFor(data?: Record<string, unknown>) {
  if (data?.propertyName === VIDEO_DEVICE_PROPERTY) {
    return {
      propertyItems: [{ itemName: "Logitech HD Pro Webcam C920", itemValue: OBS_CAMERA_ID, itemEnabled: true }],
    };
  }
  if (data?.propertyName === AUDIO_DEVICE_PROPERTY) {
    return {
      propertyItems: [{ itemName: "Microphone (USB Audio)", itemValue: OBS_MIC_ID, itemEnabled: true }],
    };
  }
  return { propertyItems: [] };
}

function clientWithExistingDshow(overrides: ConstructorParameters<typeof FakeObsClient>[0] = {}) {
  return new FakeObsClient({
    GetInputList: { inputs: [{ inputName: "Camera", inputKind: DSHOW_INPUT_KIND }] },
    GetInputPropertiesListPropertyItems: propertyItemsFor,
    RemoveInput: {},
    ...overrides,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for device session");
    }
    await Promise.resolve();
  }
}

describe("listInputPropertyDevices", () => {
  it("calls GetInputPropertiesListPropertyItems for video_device_id and maps name + ID", async () => {
    const client = new FakeObsClient({
      GetInputPropertiesListPropertyItems: propertyItemsFor,
    });

    const devices = await listInputPropertyDevices(client, "Camera", VIDEO_DEVICE_PROPERTY);

    expect(client.calls).toEqual([
      {
        requestType: "GetInputPropertiesListPropertyItems",
        requestData: { inputName: "Camera", propertyName: VIDEO_DEVICE_PROPERTY },
      },
    ]);
    expect(devices).toEqual([{ label: "Logitech HD Pro Webcam C920", deviceId: OBS_CAMERA_ID }]);
    expect(devices[0].deviceId).toBe(OBS_CAMERA_ID);
  });

  it("calls GetInputPropertiesListPropertyItems for audio_device_id", async () => {
    const client = new FakeObsClient({
      GetInputPropertiesListPropertyItems: propertyItemsFor,
    });

    const devices = await listInputPropertyDevices(client, "Camera", AUDIO_DEVICE_PROPERTY);

    expect(client.calls[0]?.requestData).toEqual({
      inputName: "Camera",
      propertyName: AUDIO_DEVICE_PROPERTY,
    });
    expect(devices).toEqual([{ label: "Microphone (USB Audio)", deviceId: OBS_MIC_ID }]);
  });

  it("skips empty and disabled items and does not stringify IDs", async () => {
    const client = new FakeObsClient({
      GetInputPropertiesListPropertyItems: {
        propertyItems: [
          { itemName: "Select a device", itemValue: "", itemEnabled: true },
          { itemName: "Disabled cam", itemValue: "gone", itemEnabled: false },
          { itemName: "Keep me", itemValue: OBS_CAMERA_ID, itemEnabled: true },
        ],
      },
    });
    const devices = await listInputPropertyDevices(client, "Camera", VIDEO_DEVICE_PROPERTY);
    expect(devices).toEqual([{ label: "Keep me", deviceId: OBS_CAMERA_ID }]);
  });
});

describe("enumerateStudioDevices", () => {
  it("reuses an existing dshow_input and lists video then audio properties", async () => {
    const client = clientWithExistingDshow();
    const listed = await enumerateStudioDevices(client);

    expect(listed.video[0]?.deviceId).toBe(OBS_CAMERA_ID);
    expect(listed.audio[0]?.deviceId).toBe(OBS_MIC_ID);

    const propCalls = client.calls.filter((c) => c.requestType === "GetInputPropertiesListPropertyItems");
    expect(propCalls.map((c) => c.requestData?.propertyName)).toEqual([
      VIDEO_DEVICE_PROPERTY,
      AUDIO_DEVICE_PROPERTY,
    ]);
    expect(propCalls.every((c) => c.requestData?.inputName === "Camera")).toBe(true);
    expect(client.calls.some((c) => c.requestType === "CreateInput")).toBe(false);
    expect(client.calls.some((c) => c.requestType === "RemoveInput")).toBe(false);
  });

  it("creates a temporary dshow_input when none exists and removes it after", async () => {
    const client = new FakeObsClient({
      GetInputList: { inputs: [] },
      GetSceneList: { currentProgramSceneName: "Scene", scenes: [{ sceneName: "Scene" }] },
      CreateInput: {},
      RemoveInput: {},
      GetInputPropertiesListPropertyItems: propertyItemsFor,
    });

    await enumerateStudioDevices(client);

    expect(client.calls.find((c) => c.requestType === "CreateInput")?.requestData).toMatchObject({
      sceneName: "Scene",
      inputName: DEVICE_PROBE_INPUT_NAME,
      inputKind: DSHOW_INPUT_KIND,
      sceneItemEnabled: false,
    });
    expect(client.calls.find((c) => c.requestType === "RemoveInput")?.requestData).toEqual({
      inputName: DEVICE_PROBE_INPUT_NAME,
    });
  });
});

describe("selected device ID is stored exactly as OBS reported it", () => {
  beforeEach(() => {
    useAppStore.setState({ showConfig: { ...DEFAULT_SHOW_CONFIG }, deviceEnum: initialDeviceEnum() });
  });

  it("writes the OBS itemValue into showConfig.camera with no rewriting", async () => {
    const client = clientWithExistingDshow();
    const listed = await enumerateStudioDevices(client);
    const choice = selectDeviceChoice(listed.video, OBS_CAMERA_ID);
    useAppStore.getState().setShowConfig({ camera: choice });

    expect(choice?.deviceId).toBe(OBS_CAMERA_ID);
    expect(useAppStore.getState().showConfig.camera?.deviceId).toBe(OBS_CAMERA_ID);
    expect(useAppStore.getState().showConfig.camera).toEqual({
      label: "Logitech HD Pro Webcam C920",
      deviceId: OBS_CAMERA_ID,
    });
  });
});

describe("startSetupDeviceSession", () => {
  beforeEach(() => {
    useAppStore.setState({ showConfig: { ...DEFAULT_SHOW_CONFIG }, deviceEnum: initialDeviceEnum() });
  });

  it("populates the store once OBS connects", async () => {
    const client = clientWithExistingDshow();
    const session = startSetupDeviceSession({ client, url: "ws://127.0.0.1:4455", password: "" });
    await waitUntil(() => useAppStore.getState().deviceEnum.connected);
    expect(useAppStore.getState().deviceEnum.video[0]?.deviceId).toBe(OBS_CAMERA_ID);
    session.stop();
  });

  it("records disconnected when connect fails, with an empty list", async () => {
    const client = new FakeObsClient();
    client.connect = async () => {
      client.connectCalls += 1;
      throw new Error("ECONNREFUSED");
    };
    const session = startSetupDeviceSession({ client, url: "ws://127.0.0.1:4455" });
    await waitUntil(() => client.connectCalls >= 1);
    expect(useAppStore.getState().deviceEnum.connected).toBe(false);
    expect(useAppStore.getState().deviceEnum.video).toEqual([]);
    session.stop();
  });

  it("re-enumerates when retry is pressed", async () => {
    const client = clientWithExistingDshow();
    const session = startSetupDeviceSession({ client, url: "ws://127.0.0.1:4455" });
    await waitUntil(() => useAppStore.getState().deviceEnum.connected);

    const countBefore = client.calls.filter(
      (c) => c.requestType === "GetInputPropertiesListPropertyItems"
    ).length;
    expect(countBefore).toBeGreaterThan(0);

    session.retry();
    await waitUntil(
      () =>
        client.calls.filter((c) => c.requestType === "GetInputPropertiesListPropertyItems").length >
        countBefore
    );

    const countAfter = client.calls.filter(
      (c) => c.requestType === "GetInputPropertiesListPropertyItems"
    ).length;
    expect(countAfter).toBeGreaterThan(countBefore);
    expect(useAppStore.getState().deviceEnum.video[0]?.deviceId).toBe(OBS_CAMERA_ID);
    session.stop();
  });

  it("returns to not-connected on ConnectionClosed and re-enumerates after retry", async () => {
    const client = clientWithExistingDshow();
    const session = startSetupDeviceSession({ client, url: "ws://127.0.0.1:4455" });
    await waitUntil(() => useAppStore.getState().deviceEnum.connected);

    client.emit("ConnectionClosed");
    expect(useAppStore.getState().deviceEnum.connected).toBe(false);

    session.retry();
    await waitUntil(() => useAppStore.getState().deviceEnum.connected);
    expect(useAppStore.getState().deviceEnum.video.length).toBe(1);
    session.stop();
  });
});
