import { subscribeObsLiveState, type LiveState } from "../obs/liveMode.js";
import type { ObsClient } from "../obs/client.js";
import { useAppStore } from "../state/store.js";

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
  client: Pick<ObsClient, "connect" | "disconnect" | "on" | "off">;
  url: string;
  password?: string;
  retryMs?: number;
}): { stop: () => void; retryNow: () => void } {
  const { client, url, password, retryMs = STUDIO_RETRY_MS } = opts;
  let cancelled = false;
  let inFlight = false;
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
