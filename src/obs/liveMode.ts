/**
 * Pure logic for the "no Go Live button" rule: this app never calls
 * StartStream. It only listens for StreamStateChanged and derives whether
 * it should show LIVE or NOT LIVE, and since when.
 */

export interface StreamStateChangedEvent {
  outputActive: boolean;
  outputState: string;
}

export interface LiveState {
  live: boolean;
  /** ms epoch the current live/not-live state began, for the elapsed timer. */
  since: number;
}

/** Fold one StreamStateChanged event into the next LiveState. `now` is
 * injected so this stays pure and testable without a real clock. */
export function deriveLiveState(event: StreamStateChangedEvent, now: number): LiveState {
  return { live: event.outputActive, since: now };
}

export function initialLiveState(now: number): LiveState {
  return { live: false, since: now };
}

/** Elapsed ms since `since`, clamped to zero — used with formatElapsed(). */
export function elapsedMs(state: LiveState, now: number): number {
  return Math.max(0, now - state.since);
}
