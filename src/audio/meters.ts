import type { ObsClient } from "../obs/client.js";
import { EVENT_SUBSCRIPTION_ALL, EVENT_SUBSCRIPTION_INPUT_VOLUME_METERS } from "./constants.js";

export interface Reidentifiable {
  reidentify?(data: { eventSubscriptions: number }): Promise<void>;
}

/** Peak (index 1) of inputLevelsMul, max across channels, clamped 0–1. */
export function parseInputVolumeMeters(data: unknown): Record<string, number> {
  if (data === null || typeof data !== "object") return {};
  const inputs = (data as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs)) return {};

  const levels: Record<string, number> = {};
  for (const input of inputs) {
    if (input === null || typeof input !== "object") continue;
    const rec = input as { inputName?: unknown; inputLevelsMul?: unknown };
    if (typeof rec.inputName !== "string") continue;
    if (!Array.isArray(rec.inputLevelsMul)) continue;
    let peak = 0;
    for (const channel of rec.inputLevelsMul) {
      if (!Array.isArray(channel) || channel.length < 2) continue;
      const value = Number(channel[1]);
      if (Number.isFinite(value) && value > peak) peak = value;
    }
    levels[rec.inputName] = Math.min(1, Math.max(0, peak));
  }
  return levels;
}

export type AudioObs = ObsClient & Reidentifiable;

/**
 * Listen for InputVolumeMeters and opt into the high-volume event.
 * The returned function offs the listener and drops the high-volume bit
 * so the stream is not carried once the panel is gone.
 */
export function subscribeInputVolumeMeters(
  client: AudioObs,
  listener: (data: unknown) => void
): () => void {
  client.on("InputVolumeMeters", listener);
  void client.reidentify?.({
    eventSubscriptions: EVENT_SUBSCRIPTION_ALL | EVENT_SUBSCRIPTION_INPUT_VOLUME_METERS,
  });
  return () => {
    client.off("InputVolumeMeters", listener);
    void client.reidentify?.({ eventSubscriptions: EVENT_SUBSCRIPTION_ALL });
  };
}
