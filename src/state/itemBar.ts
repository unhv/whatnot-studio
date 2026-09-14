/**
 * Pure state machine for the item bar and the SOLD moment. No OBS, no
 * timers — `now` is always injected so this is trivially unit-testable.
 * The renderer is responsible for calling `tick(now)` on an interval and
 * for pushing `deriveLowerThirdText`/`isOnCanvas` out to OBS via
 * SetInputSettings/SetSceneItemEnabled.
 */

export const SOLD_BANNER_MS = 2000;

export interface ItemBarState {
  item: string;
  price: string;
  onCanvas: boolean;
  /** Set while the SOLD banner is showing; null otherwise. */
  soldUntil: number | null;
}

export function initialItemBarState(): ItemBarState {
  return { item: "", price: "", onCanvas: false, soldUntil: null };
}

export type ItemBarAction =
  | { type: "SET_ITEM"; item: string; price: string }
  | { type: "SHOW" }
  | { type: "CLEAR" }
  | { type: "SOLD"; now: number; durationMs?: number }
  | { type: "TICK"; now: number };

export function itemBarReducer(state: ItemBarState, action: ItemBarAction): ItemBarState {
  switch (action.type) {
    case "SET_ITEM":
      return { ...state, item: action.item, price: action.price };

    case "SHOW":
      if (state.item.trim() === "") return state; // nothing to show
      return { ...state, onCanvas: true };

    case "CLEAR":
      return initialItemBarState();

    case "SOLD":
      // SOLD is the biggest button on the screen and always fires,
      // regardless of whether the item bar was already showing.
      return {
        ...state,
        onCanvas: true,
        soldUntil: action.now + (action.durationMs ?? SOLD_BANNER_MS),
      };

    case "TICK":
      if (state.soldUntil !== null && action.now >= state.soldUntil) {
        return initialItemBarState();
      }
      return state;

    default:
      return state;
  }
}

/** The text to push to the on-canvas lower third, or null if nothing
 * should be showing. */
export function deriveLowerThirdText(state: ItemBarState): string | null {
  if (state.soldUntil !== null) {
    return `SOLD — ${state.item} — ${state.price}`;
  }
  if (state.onCanvas && state.item.trim() !== "") {
    return `${state.item} — ${state.price}`;
  }
  return null;
}

export function isOnCanvas(state: ItemBarState): boolean {
  return deriveLowerThirdText(state) !== null;
}
