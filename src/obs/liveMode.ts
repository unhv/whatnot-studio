/**
 * Pure logic for the "no Go Live button" rule: this app never calls
 * StartStream. It only listens for StreamStateChanged and derives whether
 * it should show LIVE or NOT LIVE, and since when.
 *
 * Live-state is derived from `outputState`, never from `outputActive`.
 * A measured Whatnot show (2026-09-15) sent RECONNECTING with
 * `outputActive: false` while the seller was still live — treating that
 * boolean as truth would flash "not live" mid-auction.
 */

export interface StreamStateChangedEvent {
  outputActive: boolean;
  outputState: string;
}

export interface LiveState {
  live: boolean;
  /** STARTING: something is happening, but the seller is not live yet. */
  connecting: boolean;
  /** RECONNECTING: still live; a blip, not the end of the show. */
  reconnecting: boolean;
  /** STOPPING: still live; the stream has not ended yet. */
  stopping: boolean;
  /** obs-websocket dropped. Not the same as the show ending. */
  socketDisconnected: boolean;
  /** Last unrecognised `outputState`, if any. Null once a known state arrives. */
  unrecognizedOutputState: string | null;
  /** ms epoch the current live/not-live state began, for the elapsed timer. */
  since: number;
}

export interface LiveScreenCopy {
  /** Big status. Never contains OBS vocabulary. */
  primary: string;
  /** Reassuring secondary line, or null. Never an alarm. */
  secondary: string | null;
  showElapsed: boolean;
}

const OUTPUT_PREFIX = "OBS_WEBSOCKET_OUTPUT_";

type KnownOutputState = "STARTING" | "STARTED" | "RECONNECTING" | "STOPPING" | "STOPPED";

function parseOutputState(outputState: string): KnownOutputState | "UNKNOWN" {
  const raw = outputState.startsWith(OUTPUT_PREFIX)
    ? outputState.slice(OUTPUT_PREFIX.length)
    : outputState;
  switch (raw) {
    case "STARTING":
    case "STARTED":
    case "RECONNECTING":
    case "STOPPING":
    case "STOPPED":
      return raw;
    default:
      return "UNKNOWN";
  }
}

function flagsOff(partial: {
  live: boolean;
  connecting?: boolean;
  reconnecting?: boolean;
  stopping?: boolean;
  socketDisconnected: boolean;
  unrecognizedOutputState: string | null;
  since: number;
}): LiveState {
  return {
    live: partial.live,
    connecting: partial.connecting ?? false,
    reconnecting: partial.reconnecting ?? false,
    stopping: partial.stopping ?? false,
    socketDisconnected: partial.socketDisconnected,
    unrecognizedOutputState: partial.unrecognizedOutputState,
    since: partial.since,
  };
}

/** Fold one StreamStateChanged event into the next LiveState. `now` is
 * injected so this stays pure and testable without a real clock.
 * `outputActive` is ignored: OBS sets it false on RECONNECTING. */
export function deriveLiveState(
  prev: LiveState,
  event: StreamStateChangedEvent,
  now: number
): LiveState {
  const kind = parseOutputState(event.outputState);
  // Receiving any stream event means the websocket is up.
  const socketDisconnected = false;
  const unrecognizedOutputState = null;

  switch (kind) {
    case "STARTING": {
      const live = false;
      return flagsOff({
        live,
        connecting: true,
        socketDisconnected,
        unrecognizedOutputState,
        since: prev.live === live && prev.connecting ? prev.since : now,
      });
    }
    case "STARTED": {
      const live = true;
      return flagsOff({
        live,
        socketDisconnected,
        unrecognizedOutputState,
        since: prev.live ? prev.since : now,
      });
    }
    case "RECONNECTING": {
      const live = true;
      return flagsOff({
        live,
        reconnecting: true,
        socketDisconnected,
        unrecognizedOutputState,
        since: prev.live ? prev.since : now,
      });
    }
    case "STOPPING": {
      const live = true;
      return flagsOff({
        live,
        stopping: true,
        socketDisconnected,
        unrecognizedOutputState,
        since: prev.live ? prev.since : now,
      });
    }
    case "STOPPED": {
      const live = false;
      return flagsOff({
        live,
        socketDisconnected,
        unrecognizedOutputState,
        since: prev.live || prev.connecting ? now : prev.since,
      });
    }
    case "UNKNOWN":
      return { ...prev, unrecognizedOutputState: event.outputState };
  }
}

export function initialLiveState(now: number): LiveState {
  return flagsOff({
    live: false,
    socketDisconnected: false,
    unrecognizedOutputState: null,
    since: now,
  });
}

/**
 * Losing the obs-websocket connection is not the show ending. Keep
 * whatever live/connecting/reconnecting/stopping state we last knew.
 */
export function deriveSocketDisconnect(prev: LiveState, _now: number): LiveState {
  return { ...prev, socketDisconnected: true };
}

/** Duck-typed so this stays independent of `ObsClient` / obs-websocket-js. */
export interface LiveStateEventSource {
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}

export function asStreamStateChangedEvent(data: unknown): StreamStateChangedEvent | null {
  if (data === null || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.outputState !== "string") return null;
  return {
    outputState: rec.outputState,
    outputActive: rec.outputActive === true,
  };
}

/**
 * Subscribe an obs-websocket client to StreamStateChanged + ConnectionClosed
 * and route them through the pure fold functions' call sites. Returns an
 * unsubscribe that also detaches ConnectionClosed so a local disconnect()
 * does not look like a mid-show drop.
 */
export function subscribeObsLiveState(
  client: LiveStateEventSource,
  handlers: {
    onStreamStateChanged: (event: StreamStateChangedEvent, now: number) => void;
    onSocketDisconnect: (now: number) => void;
    now?: () => number;
  }
): () => void {
  const clock = handlers.now ?? Date.now;
  const onStream = (data: unknown) => {
    const event = asStreamStateChangedEvent(data);
    if (!event) return;
    handlers.onStreamStateChanged(event, clock());
  };
  const onClosed = () => handlers.onSocketDisconnect(clock());
  client.on("StreamStateChanged", onStream);
  client.on("ConnectionClosed", onClosed);
  return () => {
    client.off("StreamStateChanged", onStream);
    client.off("ConnectionClosed", onClosed);
  };
}

/** Elapsed ms since `since`, clamped to zero — used with formatElapsed(). */
export function elapsedMs(state: LiveState, now: number): number {
  return Math.max(0, now - state.since);
}

export const LIVE_PRIMARY = {
  goingLive: "GOING LIVE",
  live: "LIVE",
  notLive: "NOT LIVE",
} as const;

export const LIVE_SECONDARY = {
  starting: "Starting the stream",
  reconnecting: "Reconnecting — you're still live",
  stopping: "Ending the stream",
  socketLostLive: "Studio connection dropped — you're still live",
  socketLostConnecting: "Studio connection dropped — still connecting",
  socketLostIdle: "Studio connection dropped",
} as const;

/** Seller-facing copy for the LIVE screen status strip. */
export function liveScreenCopy(state: LiveState): LiveScreenCopy {
  if (state.live) {
    let secondary: string | null = null;
    if (state.reconnecting) secondary = LIVE_SECONDARY.reconnecting;
    else if (state.stopping) secondary = LIVE_SECONDARY.stopping;
    else if (state.socketDisconnected) secondary = LIVE_SECONDARY.socketLostLive;
    return { primary: LIVE_PRIMARY.live, secondary, showElapsed: true };
  }
  if (state.connecting) {
    return {
      primary: LIVE_PRIMARY.goingLive,
      secondary: state.socketDisconnected
        ? LIVE_SECONDARY.socketLostConnecting
        : LIVE_SECONDARY.starting,
      showElapsed: false,
    };
  }
  return {
    primary: LIVE_PRIMARY.notLive,
    secondary: state.socketDisconnected ? LIVE_SECONDARY.socketLostIdle : null,
    showElapsed: false,
  };
}
