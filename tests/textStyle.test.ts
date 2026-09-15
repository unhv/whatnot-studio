import { describe, it, expect, beforeEach } from "vitest";
import {
  ITEM_BAR_TRANSFORM,
  overlayBox,
  overlaySnapTransform,
  WHATNOT_SAFE_BOTTOM,
} from "../src/obs/sceneCompiler.js";
import { CANVAS_HEIGHT } from "../src/shared/types.js";
import {
  initialTextStyleState,
  loadTextStyle,
  missingSourceMessage,
  persistTextStyle,
  setTextStyleStorage,
  textStyleReducer,
  type StorageLike,
  type TextStyleState,
} from "../src/state/textStyle.js";

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("textStyleReducer", () => {
  it("defaults already sit on the named snaps with a readable fill", () => {
    const state = initialTextStyleState();
    expect(state.overlays.itemBar.snap).toBe("safe");
    expect(state.overlays.itemBar.positionY).toBe(overlaySnapTransform("itemBar", "safe", "normal").positionY);
    expect(state.overlays.soldBanner.snap).toBe("middle");
    expect(state.overlays.breakCard.snap).toBe("middle");
    expect(state.overlays.itemBar.colorref).toBe(0xffffff);
    expect(state.overlays.soldBanner.colorref).toBe(0x0028c8ff);
    expect(state.overlays.itemBar.size).toBe("normal");
    expect(state.overlays.itemBar.visible).toBe(true);
  });

  it("untouched default itemBar placement clears the Whatnot bottom safe area", () => {
    const style = initialTextStyleState().overlays.itemBar;
    const box = overlayBox("itemBar", style.size);
    // valign is centre, so the glyphs sit in the middle of the extents box.
    const glyphY = style.positionY + box.height / 2;
    const bidBarTop = CANVAS_HEIGHT - WHATNOT_SAFE_BOTTOM;
    expect(style.snap).toBe("safe");
    expect(glyphY).toBeLessThan(bidBarTop);
    expect(style.positionY + box.height).toBeLessThanOrEqual(bidBarTop);
    expect(ITEM_BAR_TRANSFORM.positionY).toBe(style.positionY);
    expect(ITEM_BAR_TRANSFORM.positionX).toBe(style.positionX);
  });

  it("DROP onto each snap stores that snap's exact position", () => {
    let state = initialTextStyleState();
    for (const snap of ["top", "middle", "bottom", "safe"] as const) {
      const t = overlaySnapTransform("itemBar", snap, "normal");
      state = textStyleReducer(state, { type: "DROP", id: "itemBar", x: t.positionX, y: t.positionY });
      expect(state.overlays.itemBar.snap).toBe(snap);
      expect(state.overlays.itemBar.positionX).toBe(t.positionX);
      expect(state.overlays.itemBar.positionY).toBe(t.positionY);
    }
  });

  it("SIZE on a snapped overlay recomputes the snap for the new box", () => {
    let state = initialTextStyleState();
    state = textStyleReducer(state, { type: "SNAP", id: "itemBar", snap: "bottom" });
    state = textStyleReducer(state, { type: "SIZE", id: "itemBar", size: "huge" });
    const t = overlaySnapTransform("itemBar", "bottom", "huge");
    expect(state.overlays.itemBar.positionY).toBe(t.positionY);
    expect(state.overlays.itemBar.size).toBe("huge");
  });

  it("TOGGLE flips visibility and MISSING speaks seller language", () => {
    let state = initialTextStyleState();
    state = textStyleReducer(state, { type: "TOGGLE", id: "breakCard" });
    expect(state.overlays.breakCard.visible).toBe(false);
    state = textStyleReducer(state, { type: "MISSING", ids: ["itemBar"] });
    expect(missingSourceMessage(state.missing)).toMatch(/Item name isn't on the canvas/);
    expect(missingSourceMessage(state.missing)).toMatch(/Put the scenes back/);
  });

  it("survives a restart: persist then load restores the seller's colour and place", () => {
    const storage = new MemoryStorage();
    let state: TextStyleState = initialTextStyleState();
    state = textStyleReducer(state, { type: "SNAP", id: "itemBar", snap: "top" });
    state = textStyleReducer(state, { type: "COLOR", id: "itemBar", colorref: 0x000000ff });
    state = textStyleReducer(state, { type: "SIZE", id: "soldBanner", size: "huge" });
    persistTextStyle("Friday Night", state, storage);

    const loaded = loadTextStyle("Friday Night", storage);
    expect(loaded.overlays.itemBar.snap).toBe("top");
    expect(loaded.overlays.itemBar.colorref).toBe(0x000000ff);
    expect(loaded.overlays.soldBanner.size).toBe("huge");
    expect(loadTextStyle("Some Other Show", storage).overlays.itemBar.snap).toBe("safe");
  });
});

describe("textStyle storage injection", () => {
  beforeEach(() => setTextStyleStorage(undefined));

  it("uses the injected storage when load/persist omit it", () => {
    const storage = new MemoryStorage();
    setTextStyleStorage(storage);
    const state = textStyleReducer(initialTextStyleState(), {
      type: "COLOR",
      id: "breakCard",
      colorref: 0x000000ff,
    });
    persistTextStyle("Show A", state);
    expect(loadTextStyle("Show A").overlays.breakCard.colorref).toBe(0x000000ff);
    setTextStyleStorage(undefined);
  });
});
