import { subscribeObsLiveState, type LiveState } from "../obs/liveMode.js";
import { syncScenes } from "../obs/applyPlan.js";
import type { ObsClient } from "../obs/client.js";
import { buildDesiredScenes } from "../obs/sceneCompiler.js";
import { loadCameraLayout, type StorageLike } from "../state/cameraLayout.js";
import { loadTextStyle } from "../state/textStyle.js";
import { useAppStore } from "../state/store.js";

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
  useAppStore.setState({ screen: "setup" });
}

/**
 * Session listener for the LIVE screen. First-run's ObsClient is discarded
 * after setup; this is what actually folds StreamStateChanged /
 * ConnectionClosed into the store. A drop leaves those listeners on a dead
 * socket, so we reconnect and resubscribe — otherwise a later STOPPED never
 * arrives and the seller cannot leave this screen.
 */
export function startLiveScreenSession(opts: {
  client: Pick<ObsClient, "connect" | "disconnect" | "on" | "off" | "call">;
  url: string;
  password?: string;
  retryMs?: number;
  /** Override for tests. Default applies `buildDesiredScenes` once per session. */
  applyScenes?: (client: Pick<ObsClient, "call">) => Promise<void>;
  /** Injected storage for the persisted BOTH layout. Default is localStorage. */
  layoutStorage?: StorageLike | null;
}): { stop: () => void; retryNow: () => void } {
  const { client, url, password, retryMs = STUDIO_RETRY_MS } = opts;
  const applyScenes =
    opts.applyScenes ??
    ((obs) => {
      const config = useAppStore.getState().showConfig;
      return syncScenes(
        obs as ObsClient,
        buildDesiredScenes(
          config,
          { breakCard: loadTextStyle(config.showName).overlays.breakCard.visible },
          loadCameraLayout(
            opts.layoutStorage !== undefined ? opts.layoutStorage : browserLayoutStorage()
          )
        )
      );
    });
  let cancelled = false;
  let inFlight = false;
  let scenesApplied = false;
  let unsubscribe = () => {};
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
      unsubscribe = subscribeObsLiveState(client, {
        onStreamStateChanged: applyStreamStateChanged,
        onSocketDisconnect: (t) => {
          applySocketDisconnect(t);
          setConnectionStatus("disconnected");
          scheduleRetry();
        },
      });
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
      unsubscribe();
      void client.disconnect();
    },
    retryNow: () => {
      clearRetry();
      void connectAndSubscribe();
    },
  };
}
