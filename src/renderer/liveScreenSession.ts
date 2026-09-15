import { subscribeObsLiveState, type LiveState } from "../obs/liveMode.js";
import { syncScenes } from "../obs/applyPlan.js";
import type { ObsClient } from "../obs/client.js";
import { enumerateStudioDevices } from "../obs/devices.js";
import { buildDesiredScenes } from "../obs/sceneCompiler.js";
import { loadCameraLayout, type StorageLike } from "../state/cameraLayout.js";
import { loadSurroundResolveOpts } from "../state/surround.js";
import { loadTextStyle } from "../state/textStyle.js";
import { persistableShowConfig, useAppStore } from "../state/store.js";
import {
  foldHealth,
  HEALTH_POLL_MS,
  healthSampleFromObs,
  initialHealthState,
} from "../obs/health.js";
import {
  ENCODER_REVERT_MESSAGE,
  foldEncoderGoLive,
  idleEncoderWatch,
  pendingEncoderWatch,
  revertHardwareEncoder,
} from "../obs/quality.js";
import { applyGoLiveQuality } from "./goLiveQuality.js";
import {
  parseShowStore,
  serializeShowStore,
  snapshotShowExtras,
  upsertShow,
} from "../state/showStore.js";

function browserLayoutStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const STUDIO_RETRY_MS = 2000;

export function canReturnToSetup(live: LiveState): boolean {
  return !live.live || live.socketDisconnected;
}

export function clearStudioDropFlag(): void {
  useAppStore.setState((s) => ({ live: { ...s.live, socketDisconnected: false } }));
}

export function returnToSetup(): void {
  const live = useAppStore.getState().live;
  if (!canReturnToSetup(live)) return;
  useAppStore.setState({ screen: "setup", goLiveQualityApplied: false });
}

/**
 * Session listener for the LIVE screen. First-run's ObsClient is discarded
 * after setup; this is what actually folds StreamStateChanged /
 * ConnectionClosed into the store. A drop leaves those listeners on a dead
 * socket, so we reconnect and resubscribe — otherwise a later STOPPED never
 * arrives and the seller cannot leave this screen.
 */
async function persistShowConfigPatch(): Promise<void> {
  const api = typeof window !== "undefined" ? window.whatnotStudio : undefined;
  if (!api || typeof api.loadShowStore !== "function" || typeof api.saveShowStore !== "function") return;
  try {
    const config = persistableShowConfig(useAppStore.getState().showConfig);
    const raw = await api.loadShowStore();
    const next = upsertShow(parseShowStore(raw), config, snapshotShowExtras(config.showName));
    await api.saveShowStore(serializeShowStore(next));
  } catch {
    // in-memory patch still holds for this session
  }
}

export function startLiveScreenSession(opts: {
  client: Pick<ObsClient, "connect" | "disconnect" | "on" | "off" | "call">;
  url: string;
  password?: string;
  retryMs?: number;
  healthPollMs?: number;
  /** Override for tests. Default applies `buildDesiredScenes` once per session. */
  applyScenes?: (client: Pick<ObsClient, "call">) => Promise<void>;
  /** Injected storage for the persisted BOTH layout. Default is localStorage. */
  layoutStorage?: StorageLike | null;
}): { stop: () => void; retryNow: () => void } {
  const { client, url, password, retryMs = STUDIO_RETRY_MS, healthPollMs = HEALTH_POLL_MS } = opts;
  const applyScenes =
    opts.applyScenes ??
    (async (obs) => {
      const config = useAppStore.getState().showConfig;
      const layout = loadCameraLayout(
        opts.layoutStorage !== undefined ? opts.layoutStorage : browserLayoutStorage()
      );
      const surroundOpts = await loadSurroundResolveOpts(layout.surroundId);
      return syncScenes(
        obs as ObsClient,
        buildDesiredScenes(
          config,
          { breakCard: loadTextStyle(config.showName).overlays.breakCard.visible },
          layout,
          surroundOpts
        )
      );
    });
  let cancelled = false;
  let inFlight = false;
  let scenesApplied = false;
  let qualityApplyStarted = false;
  let unsubscribe = () => {};
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let health = initialHealthState(Date.now());

  function stopHealthPoll() {
    if (healthTimer !== null) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  async function pollHealth() {
    if (cancelled) return;
    try {
      const stream = await client.call<{
        outputSkippedFrames?: number;
        outputBytes?: number;
        outputCongestion?: number;
      }>("GetStreamStatus");
      const stats = await client.call<{
        renderSkippedFrames?: number;
        cpuUsage?: number;
      }>("GetStats");
      const live = useAppStore.getState().live;
      health = foldHealth(
        health,
        healthSampleFromObs(stream, stats, { live: live.live, reconnecting: live.reconnecting }),
        Date.now()
      );
      if (!cancelled) useAppStore.getState().setHealthWarning(health.warning);
    } catch {
      // A failed poll is not a warning.
    }
  }

  function startHealthPoll() {
    stopHealthPoll();
    health = initialHealthState(Date.now());
    void pollHealth();
    healthTimer = setInterval(() => {
      void pollHealth();
    }, healthPollMs);
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (cancelled) return;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connectAndSubscribe();
    }, retryMs);
  }

  async function connectAndSubscribe() {
    if (cancelled || inFlight) return;
    inFlight = true;
    clearRetry();
    unsubscribe();
    unsubscribe = () => {};
    const { applyStreamStateChanged, applySocketDisconnect, setConnectionStatus } =
      useAppStore.getState();
    try {
      setConnectionStatus("connecting");
      try {
        await client.disconnect();
      } catch {
        // already closed
      }
      await client.connect(url, password);
      if (cancelled) {
        await client.disconnect();
        return;
      }
      // First-run writes a one-scene skeleton named "Scene". The Item Bar
      // and SOLD Banner only exist after this plan lands. Run once per
      // session — compiling again would SetSceneItemEnabled(false) on the
      // overlays and hide whatever the seller currently has on canvas.
      if (!scenesApplied) {
        try {
          await applyScenes(client);
          scenesApplied = true;
        } catch {
          // overlays missing until the next successful apply; going live
          // and the item-bar UI must not throw
        }
      }
      if (cancelled) {
        await client.disconnect();
        return;
      }
      // A successful connect must clear the drop flag immediately. Waiting
      // for StreamStateChanged leaves "studio connection dropped" on screen
      // after a blip when the seller is not (yet) live.
      clearStudioDropFlag();
      setConnectionStatus("connected");
      const cfg = useAppStore.getState().showConfig;
      if (cfg.hardwareEncoderPending) {
        useAppStore.getState().setEncoderWatch(
          pendingEncoderWatch({
            simple: cfg.previousSimpleEncoder ?? null,
            adv: cfg.previousAdvEncoder ?? null,
          })
        );
      } else {
        useAppStore.getState().setEncoderWatch(idleEncoderWatch());
      }
      unsubscribe = subscribeObsLiveState(client, {
        onStreamStateChanged: (event, now) => {
          applyStreamStateChanged(event, now);
          const store = useAppStore.getState();
          const folded = foldEncoderGoLive(store.encoderWatch, event);
          store.setEncoderWatch(folded.next);
          if (folded.action === "confirm") {
            store.setShowConfig({ hardwareEncoderPending: false });
            void persistShowConfigPatch();
          }
          if (folded.action === "revert") {
            void (async () => {
              try {
                await revertHardwareEncoder(client as ObsClient, folded.next.previous);
              } catch {
                // revert is best-effort; still tell the seller
              }
              if (cancelled) return;
              useAppStore.getState().setShowConfig({
                hardwareEncoder: false,
                hardwareEncoderPending: false,
              });
              useAppStore.getState().setEncoderRevertMessage(ENCODER_REVERT_MESSAGE);
              void persistShowConfigPatch();
            })();
          }
        },
        onSocketDisconnect: (t) => {
          applySocketDisconnect(t);
          setConnectionStatus("disconnected");
          stopHealthPoll();
          scheduleRetry();
        },
      });
      startHealthPoll();
      // Enumeration feeds the stored-camera re-check but must never block
      // session setup or the listener re-attach behind an OBS request the
      // seller's live session does not need to wait on — a slow or
      // never-answered call here must not delay clearing inFlight, or a
      // ConnectionClosed retry that arrives while it is outstanding is
      // silently dropped.
      void enumerateStudioDevices(client as ObsClient)
        .then((devices) => {
          if (!cancelled) {
            useAppStore.getState().setDeviceEnum({
              connected: true,
              video: devices.video,
              audio: devices.audio,
            });
          }
        })
        .catch(() => {
          // Failed to list devices is not "enumerated without this camera".
        });
      // Boot-to-LIVE and picker-to-LIVE skip Setup's Continue. Re-test here
      // so a noon measurement cannot pin a 9pm show. Do not await: the
      // upload probe can take seconds and must not hold inFlight.
      if (!qualityApplyStarted && !useAppStore.getState().goLiveQualityApplied) {
        qualityApplyStarted = true;
        void applyGoLiveQuality({ obs: client as ObsClient })
          .then((result) => {
            if (cancelled) return;
            useAppStore.getState().setGoLiveQualityApplied(true);
            if (result.cameraMissing) {
              useAppStore.getState().goToSetup();
            }
          })
          .catch(() => {
            qualityApplyStarted = false;
          });
      }
    } catch {
      if (!cancelled) {
        applySocketDisconnect(Date.now());
        setConnectionStatus("error");
        scheduleRetry();
      }
    } finally {
      inFlight = false;
    }
  }

  void connectAndSubscribe();

  return {
    stop: () => {
      cancelled = true;
      clearRetry();
      stopHealthPoll();
      unsubscribe();
      void client.disconnect();
    },
    retryNow: () => {
      clearRetry();
      void connectAndSubscribe();
    },
  };
}
