/**
 * Drives the meme-clip overlay on OBS. Press → point the ffmpeg_source at
 * the file, show it, restart so the same clip can fire twice. Hide is
 * driven by MediaInputPlaybackEnded, not a timer matching clip length.
 */
import type { ObsClient } from "../obs/client.js";
import {
  CAMERA_FACING_SCENES,
  CLIP_OVERLAY_SOURCE,
  containCanvasTransform,
  type Transform,
} from "../obs/sceneCompiler.js";
import { CLIPS_COPY, clipVolumeMul, type Clip, type ClipVolumeStepId } from "../state/clips.js";

export const MEDIA_RESTART_ACTION = "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART";

/** ffmpeg_source reports sourceWidth/Height only after the file is open.
 * close_when_inactive is forced off at play so the decoder starts while the
 * overlay is still disabled. Poll until size arrives; then contain-fit. */
export const SOURCE_SIZE_WAIT_MS = 1500;
export const SOURCE_SIZE_POLL_MS = 50;

export interface ClipClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: ClipClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface ClipPlayerOpts {
  getClient: () => ObsClient | null;
  isConnected?: () => boolean;
  fileExists?: (path: string) => Promise<boolean>;
  clock?: ClipClock;
  onEnded?: () => void;
  onError?: (message: string) => void;
}

/**
 * Backstop only. Hide is MediaInputPlaybackEnded; a timer matched to clip
 * length drifts and leaves a frozen last frame on the show. This fires
 * later than any clip we expect, in case OBS never sends the event.
 */
export function safetyTimeoutMs(durationMs: number | null): number {
  if (durationMs !== null && durationMs > 0) return durationMs + 10_000;
  return 30_000;
}

export class ClipPlayer {
  private readonly clock: ClipClock;
  private chain: Promise<void> = Promise.resolve();
  private idCache = new Map<string, number>();
  private attached: ObsClient | null = null;
  private playLock = 0;
  private playing = false;
  private safetyTimer: unknown = null;
  private readonly onMediaEnded = (data: unknown) => {
    this.enqueue(() => this.handleMediaEnded(data));
  };
  private readonly onClosed = () => {
    this.enqueue(() => this.handleDisconnect());
  };

  constructor(private readonly opts: ClipPlayerOpts) {
    this.clock = opts.clock ?? realClock;
    this.attach();
  }

  idle(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    this.clearSafety();
    this.detach();
    this.idCache.clear();
    this.playing = false;
  }

  attach(): void {
    const client = this.opts.getClient();
    if (!client || client === this.attached) return;
    this.detach();
    this.attached = client;
    client.on("MediaInputPlaybackEnded", this.onMediaEnded);
    client.on("ConnectionClosed", this.onClosed);
  }

  play(clip: Clip, muted: boolean, volumeStep?: ClipVolumeStepId): void {
    this.enqueue(() => this.playNow(clip, muted, volumeStep ?? clip.volumeStep));
  }

  hide(): void {
    this.enqueue(() => this.hideNow());
  }

  /** Mute/unmute the live overlay. No-op if nothing is playing. */
  setMuted(muted: boolean, volumeStep: ClipVolumeStepId): void {
    this.enqueue(() => this.setMutedNow(muted, volumeStep));
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work, work).catch(() => {});
  }

  private readyClient(): ObsClient | null {
    const client = this.opts.getClient();
    if (!client) return null;
    if (this.opts.isConnected && !this.opts.isConnected()) return null;
    return client;
  }

  private async playNow(clip: Clip, muted: boolean, volumeStep: ClipVolumeStepId): Promise<void> {
    this.attach();
    if (!clip.usable) {
      this.opts.onError?.(clip.reason ?? CLIPS_COPY.unsupported);
      return;
    }
    const client = this.readyClient();
    if (!client) {
      this.opts.onError?.(CLIPS_COPY.disconnected);
      return;
    }
    if (this.opts.fileExists) {
      let exists = false;
      try {
        exists = await this.opts.fileExists(clip.filePath);
      } catch {
        exists = false;
      }
      if (!exists) {
        this.opts.onError?.(CLIPS_COPY.missing);
        return;
      }
    }

    this.playLock += 1;
    this.playing = true;
    this.clearSafety();
    try {
      await client.call("SetInputSettings", {
        inputName: CLIP_OVERLAY_SOURCE,
        inputSettings: {
          is_local_file: true,
          local_file: clip.filePath,
          looping: false,
          close_when_inactive: false,
        },
        overlay: true,
      });
      await client.call("SetInputVolume", {
        inputName: CLIP_OVERLAY_SOURCE,
        inputVolumeMul: muted ? 0 : clipVolumeMul(volumeStep),
      });
      await this.fitOverlay(client);
      for (const sceneName of CAMERA_FACING_SCENES) {
        await this.toggleSceneItem(client, sceneName, true);
      }
      await client.call("TriggerMediaInputAction", {
        inputName: CLIP_OVERLAY_SOURCE,
        mediaAction: MEDIA_RESTART_ACTION,
      });
      this.armSafety(clip.durationMs);
    } catch {
      this.playing = false;
      this.opts.onError?.(CLIPS_COPY.disconnected);
    } finally {
      this.playLock -= 1;
    }
  }

  private async setMutedNow(muted: boolean, volumeStep: ClipVolumeStepId): Promise<void> {
    if (!this.playing) return;
    const client = this.readyClient();
    if (!client) return;
    try {
      await client.call("SetInputVolume", {
        inputName: CLIP_OVERLAY_SOURCE,
        inputVolumeMul: muted ? 0 : clipVolumeMul(volumeStep),
      });
    } catch {
      // live mute is best-effort; next press still applies
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(() => resolve(), ms);
    });
  }

  private async readSourceSize(
    client: ObsClient,
    sceneName: string,
    sceneItemId: number
  ): Promise<{ width: number; height: number } | null> {
    const res = await client.call<{
      sceneItemTransform?: { sourceWidth?: number; sourceHeight?: number };
      sourceWidth?: number;
      sourceHeight?: number;
    }>("GetSceneItemTransform", { sceneName, sceneItemId });
    const raw = res.sceneItemTransform ?? res;
    const sourceWidth = Number(raw.sourceWidth);
    const sourceHeight = Number(raw.sourceHeight);
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
    return { width: sourceWidth, height: sourceHeight };
  }

  private async waitForSourceSize(
    client: ObsClient,
    sceneName: string,
    sceneItemId: number
  ): Promise<{ width: number; height: number } | null> {
    const deadline = this.clock.now() + SOURCE_SIZE_WAIT_MS;
    for (;;) {
      const size = await this.readSourceSize(client, sceneName, sceneItemId);
      if (size) return size;
      if (this.clock.now() >= deadline) return null;
      await this.sleep(SOURCE_SIZE_POLL_MS);
    }
  }

  /** Contain-fit from the decoder's size. Best-effort: if size never
   * arrives, leave the overlay's existing transform and still play. */
  private async fitOverlay(client: ObsClient): Promise<void> {
    try {
      const sceneName = CAMERA_FACING_SCENES[0]!;
      const sceneItemId = await this.resolveItemId(client, sceneName);
      const size = await this.waitForSourceSize(client, sceneName, sceneItemId);
      if (!size) return;
      const transform: Transform = containCanvasTransform(size.width, size.height);
      for (const name of CAMERA_FACING_SCENES) {
        const id = await this.resolveItemId(client, name);
        await client.call("SetSceneItemTransform", {
          sceneName: name,
          sceneItemId: id,
          sceneItemTransform: transform,
        });
      }
    } catch {
      // measurement failed — a slightly wrong size still beats no meme
    }
  }

  private async hideNow(): Promise<void> {
    this.clearSafety();
    this.playing = false;
    const client = this.readyClient();
    if (!client) {
      this.opts.onEnded?.();
      return;
    }
    try {
      for (const sceneName of CAMERA_FACING_SCENES) {
        try {
          await this.toggleSceneItem(client, sceneName, false);
        } catch {
          // disconnected or source missing — UI must not throw
        }
      }
    } catch {
      // swallow
    }
    this.opts.onEnded?.();
  }

  private armSafety(durationMs: number | null): void {
    this.clearSafety();
    const ms = safetyTimeoutMs(durationMs);
    this.safetyTimer = this.clock.setTimeout(() => {
      this.safetyTimer = null;
      if (!this.playing) return;
      this.enqueue(() => this.hideNow());
    }, ms);
  }

  private clearSafety(): void {
    if (this.safetyTimer !== null && this.safetyTimer !== undefined) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private async handleMediaEnded(data: unknown): Promise<void> {
    const inputName =
      data && typeof data === "object" && "inputName" in data
        ? (data as { inputName?: unknown }).inputName
        : undefined;
    if (typeof inputName === "string" && inputName !== CLIP_OVERLAY_SOURCE) return;
    if (this.playLock > 0) return;
    if (!this.playing) return;

    const client = this.readyClient();
    if (client) {
      try {
        const status = await client.call<{ mediaState?: string }>("GetMediaInputStatus", {
          inputName: CLIP_OVERLAY_SOURCE,
        });
        const mediaState = status?.mediaState;
        if (
          mediaState === "OBS_MEDIA_STATE_PLAYING" ||
          mediaState === "OBS_MEDIA_STATE_OPENING" ||
          mediaState === "OBS_MEDIA_STATE_BUFFERING"
        ) {
          return;
        }
      } catch {
        // socket died mid-clip — still clear local playing state
      }
    }
    await this.hideNow();
  }

  private async handleDisconnect(): Promise<void> {
    this.clearSafety();
    this.playing = false;
    this.opts.onEnded?.();
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached.off("MediaInputPlaybackEnded", this.onMediaEnded);
    this.attached.off("ConnectionClosed", this.onClosed);
    this.attached = null;
  }

  private cacheKey(sceneName: string): string {
    return `${sceneName}\0${CLIP_OVERLAY_SOURCE}`;
  }

  private async toggleSceneItem(client: ObsClient, sceneName: string, enabled: boolean): Promise<void> {
    const key = this.cacheKey(sceneName);
    try {
      const sceneItemId = await this.resolveItemId(client, sceneName);
      await client.call("SetSceneItemEnabled", {
        sceneName,
        sceneItemId,
        sceneItemEnabled: enabled,
      });
    } catch {
      this.idCache.delete(key);
      const sceneItemId = await this.resolveItemId(client, sceneName);
      await client.call("SetSceneItemEnabled", {
        sceneName,
        sceneItemId,
        sceneItemEnabled: enabled,
      });
    }
  }

  private async resolveItemId(client: ObsClient, sceneName: string): Promise<number> {
    const key = this.cacheKey(sceneName);
    const cached = this.idCache.get(key);
    if (cached !== undefined) return cached;
    const res = await client.call<{ sceneItemId: number }>("GetSceneItemId", {
      sceneName,
      sourceName: CLIP_OVERLAY_SOURCE,
    });
    this.idCache.set(key, res.sceneItemId);
    return res.sceneItemId;
  }
}
