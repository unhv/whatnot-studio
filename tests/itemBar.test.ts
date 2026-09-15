import { describe, it, expect } from "vitest";
import {
  deriveLowerThirdText,
  initialItemBarState,
  isOnCanvas,
  itemBarReducer,
  SOLD_BANNER_MS,
} from "../src/state/itemBar.js";

describe("itemBarReducer", () => {
  it("SET_ITEM then SHOW puts the item on canvas", () => {
    let state = initialItemBarState();
    state = itemBarReducer(state, { type: "SET_ITEM", item: "Vintage Mug", price: "$12" });
    state = itemBarReducer(state, { type: "SHOW" });
    expect(isOnCanvas(state)).toBe(true);
    expect(deriveLowerThirdText(state)).toBe("Vintage Mug — $12");
  });

  it("SHOW with an empty item does nothing", () => {
    const state = itemBarReducer(initialItemBarState(), { type: "SHOW" });
    expect(isOnCanvas(state)).toBe(false);
  });

  it("CLEAR resets everything, even mid-SOLD", () => {
    let state = itemBarReducer(initialItemBarState(), { type: "SET_ITEM", item: "Mug", price: "$12" });
    state = itemBarReducer(state, { type: "SOLD", now: 1000 });
    state = itemBarReducer(state, { type: "CLEAR" });
    expect(state).toEqual(initialItemBarState());
  });

  it("SOLD shows the banner even if the item bar was never explicitly SHOWn", () => {
    let state = itemBarReducer(initialItemBarState(), { type: "SET_ITEM", item: "Mug", price: "$12" });
    state = itemBarReducer(state, { type: "SOLD", now: 1000 });
    expect(deriveLowerThirdText(state)).toBe("SOLD — Mug — $12");
  });

  it("SOLD keeps the item onCanvas so a separate SOLD source can sit on top of the item bar", () => {
    let state = itemBarReducer(initialItemBarState(), { type: "SET_ITEM", item: "Mug", price: "$12" });
    state = itemBarReducer(state, { type: "SOLD", now: 1000 });
    expect(state.onCanvas).toBe(true);
    expect(state.soldUntil).toBe(1000 + SOLD_BANNER_MS);
    expect(isOnCanvas(state)).toBe(true);
  });

  it("TICK auto-clears once soldUntil has passed", () => {
    let state = itemBarReducer(initialItemBarState(), { type: "SET_ITEM", item: "Mug", price: "$12" });
    state = itemBarReducer(state, { type: "SOLD", now: 1000 });
    const before = itemBarReducer(state, { type: "TICK", now: 1000 + SOLD_BANNER_MS - 1 });
    expect(deriveLowerThirdText(before)).toBe("SOLD — Mug — $12");

    const after = itemBarReducer(state, { type: "TICK", now: 1000 + SOLD_BANNER_MS });
    expect(after).toEqual(initialItemBarState());
  });

  it("TICK is a no-op when there is no pending SOLD banner", () => {
    const state = itemBarReducer(initialItemBarState(), { type: "TICK", now: 9999 });
    expect(state).toEqual(initialItemBarState());
  });
});
