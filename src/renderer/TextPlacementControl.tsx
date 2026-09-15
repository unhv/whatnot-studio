import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../shared/types.js";
import {
  BREAK_CARD_TEXT,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  SOLD_BANNER_TEXT,
  TEXT_COLOR_PRESETS,
  TEXT_SIZE_NAMES,
  WHATNOT_SAFE_BOTTOM,
  WHATNOT_SAFE_TOP,
  canvasPointFromPreview,
  colorrefToCssHex,
  cssHexToColorref,
  fillUnreadableOnMat,
  overlayBox,
  type TextOverlayId,
} from "../obs/sceneCompiler.js";
import {
  OVERLAY_LABELS,
  missingSourceMessage,
  persistTextStyle,
  textStyleReducer,
  loadTextStyle,
  type TextStyleAction,
  type TextStyleObsSync,
  type TextStyleState,
} from "../state/textStyle.js";

const PREVIEW_LABEL: Record<TextOverlayId, string> = {
  itemBar: "ITEM · $12",
  soldBanner: SOLD_BANNER_TEXT,
  breakCard: BREAK_CARD_TEXT,
};

export function useTextStyleSession(showName: string) {
  const [state, setState] = useState<TextStyleState>(() => loadTextStyle(showName));
  const stateRef = useRef(state);
  stateRef.current = state;
  const syncRef = useRef<TextStyleObsSync | null>(null);
  const showNameRef = useRef(showName);
  showNameRef.current = showName;

  useEffect(() => {
    const loaded = loadTextStyle(showName);
    stateRef.current = loaded;
    setState(loaded);
  }, [showName]);

  const dispatch = useCallback((action: TextStyleAction) => {
    const prev = stateRef.current;
    const next = textStyleReducer(prev, action);
    stateRef.current = next;
    setState(next);
    if (action.type !== "MISSING") {
      persistTextStyle(showNameRef.current, next);
    }
    if (action.type !== "MISSING" && action.type !== "REHYDRATE") {
      syncRef.current?.notify(prev, next, action.type === "DRAG" ? "drag" : "commit");
    }
  }, []);

  return { state, dispatch, syncRef, stateRef };
}

export default function TextPlacementControl(props: {
  state: TextStyleState;
  dispatch: (action: TextStyleAction) => void;
  onRestore: () => void;
  itemPreview?: string;
}) {
  const { state, dispatch, onRestore } = props;
  const [selected, setSelected] = useState<TextOverlayId>("itemBar");
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: TextOverlayId; grabX: number; grabY: number } | null>(null);

  const overlay = state.overlays[selected];
  const warn = fillUnreadableOnMat(overlay.colorref);
  const missingCopy = missingSourceMessage(state.missing);

  const previewText = (id: TextOverlayId) => {
    if (id === "itemBar" && props.itemPreview) return props.itemPreview;
    return PREVIEW_LABEL[id];
  };

  const onPointerDown = (id: TextOverlayId, e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pt = canvasPointFromPreview(e.clientX, e.clientY, rect);
    const style = state.overlays[id];
    dragRef.current = { id, grabX: pt.x - style.positionX, grabY: pt.y - style.positionY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pt = canvasPointFromPreview(e.clientX, e.clientY, rect);
    dispatch({ type: "DRAG", id: drag.id, x: pt.x - drag.grabX, y: pt.y - drag.grabY });
  };

  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    dragRef.current = null;
    const rect = canvas.getBoundingClientRect();
    const pt = canvasPointFromPreview(e.clientX, e.clientY, rect);
    dispatch({ type: "DROP", id: drag.id, x: pt.x - drag.grabX, y: pt.y - drag.grabY });
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={canvasRef}
        data-testid="text-placement-canvas"
        className="relative mx-auto overflow-hidden rounded-md ring-1 ring-emerald-950"
        style={{
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          background: "linear-gradient(180deg, #0a2e24 0%, #071c16 40%, #0a241c 100%)",
        }}
      >
        {/* Felt lanes — thirds + Whatnot chrome so the seller can see the snaps. */}
        <div
          className="pointer-events-none absolute inset-x-0 bg-black/55"
          style={{ top: 0, height: (WHATNOT_SAFE_TOP / CANVAS_HEIGHT) * PREVIEW_HEIGHT }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bg-black/55"
          style={{
            bottom: 0,
            height: (WHATNOT_SAFE_BOTTOM / CANVAS_HEIGHT) * PREVIEW_HEIGHT,
          }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-amber-200/25"
          style={{ top: (CANVAS_HEIGHT / 3 / CANVAS_HEIGHT) * PREVIEW_HEIGHT }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-amber-200/25"
          style={{ top: ((CANVAS_HEIGHT * 2) / 3 / CANVAS_HEIGHT) * PREVIEW_HEIGHT }}
        />
        <div className="pointer-events-none absolute left-1 top-1 text-[10px] font-semibold uppercase tracking-wider text-amber-100/50">
          Whatnot covers this
        </div>
        <div
          className="pointer-events-none absolute left-1 text-[10px] font-semibold uppercase tracking-wider text-amber-100/50"
          style={{ bottom: 4 }}
        >
          Bid bar
        </div>

        {(["itemBar", "soldBanner", "breakCard"] as TextOverlayId[]).map((id) => {
          const style = state.overlays[id];
          if (!style.visible && id !== selected) return null;
          const box = overlayBox(id, style.size);
          const fill = colorrefToCssHex(style.colorref);
          const selectedRing = selected === id ? "ring-2 ring-amber-300" : "ring-1 ring-black/40";
          return (
            <button
              key={id}
              type="button"
              data-testid={`text-chip-${id}`}
              aria-label={`Move ${OVERLAY_LABELS[id]}`}
              className={`absolute flex cursor-grab items-center justify-center px-1 text-center font-black leading-tight active:cursor-grabbing ${selectedRing} ${
                style.visible ? "opacity-100" : "opacity-40"
              }`}
              style={{
                left: (style.positionX / CANVAS_WIDTH) * PREVIEW_WIDTH,
                top: (style.positionY / CANVAS_HEIGHT) * PREVIEW_HEIGHT,
                width: (box.width / CANVAS_WIDTH) * PREVIEW_WIDTH,
                height: (box.height / CANVAS_HEIGHT) * PREVIEW_HEIGHT,
                color: fill,
                background: "rgba(0,0,0,0.7)",
                textShadow: "0 0 2px #000, 0 1px 0 #000, 0 -1px 0 #000, 1px 0 0 #000, -1px 0 0 #000",
                fontSize: id === "soldBanner" ? 22 : id === "breakCard" ? 14 : 13,
                touchAction: "none",
              }}
              onPointerDown={(e) => onPointerDown(id, e)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {previewText(id)}
            </button>
          );
        })}
      </div>

      {missingCopy ? (
        <div className="rounded-md bg-amber-500/15 px-3 py-3 text-sm text-amber-100">
          <div>{missingCopy}</div>
          <button
            type="button"
            className="mt-2 h-12 w-full rounded-md bg-amber-400 text-base font-semibold text-neutral-950 hover:bg-amber-300"
            onClick={onRestore}
          >
            Put the scenes back
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        {(["itemBar", "soldBanner", "breakCard"] as TextOverlayId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`h-12 rounded-md text-sm font-semibold ${
              selected === id ? "bg-amber-500 text-neutral-950" : "bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
            }`}
            onClick={() => setSelected(id)}
          >
            {OVERLAY_LABELS[id]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TEXT_COLOR_PRESETS.map((p) => {
          const on = overlay.colorref === p.colorref;
          return (
            <button
              key={p.id}
              type="button"
              aria-label={p.label}
              title={p.label}
              className={`h-12 w-12 rounded-md ring-2 ${on ? "ring-amber-300" : "ring-neutral-700"}`}
              style={{ background: colorrefToCssHex(p.colorref) }}
              onClick={() => dispatch({ type: "COLOR", id: selected, colorref: p.colorref })}
            />
          );
        })}
        <label className="relative h-12 w-12 overflow-hidden rounded-md ring-2 ring-neutral-700" title="Custom colour">
          <span className="sr-only">Custom colour</span>
          <input
            type="color"
            aria-label="Custom colour"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            value={colorrefToCssHex(overlay.colorref)}
            onChange={(e) =>
              dispatch({ type: "COLOR", id: selected, colorref: cssHexToColorref(e.target.value) })
            }
          />
          <span
            className="block h-full w-full"
            style={{
              background: `conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)`,
            }}
          />
        </label>
      </div>

      {warn ? (
        <div className="text-sm text-amber-200">
          That colour will vanish on a busy card mat — pick a lighter fill, or the outline cannot save it.
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        {TEXT_SIZE_NAMES.map((size) => (
          <button
            key={size}
            type="button"
            className={`h-16 rounded-md text-base font-semibold capitalize ${
              overlay.size === size
                ? "bg-amber-500 text-neutral-950"
                : "bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
            }`}
            onClick={() => dispatch({ type: "SIZE", id: selected, size })}
          >
            {size}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`h-16 rounded-md text-lg font-semibold ${
          overlay.visible ? "bg-neutral-900 text-neutral-100 hover:bg-neutral-800" : "bg-red-600 text-white"
        }`}
        onClick={() => dispatch({ type: "TOGGLE", id: selected })}
      >
        {overlay.visible ? `Hide ${OVERLAY_LABELS[selected]}` : `Show ${OVERLAY_LABELS[selected]}`}
      </button>
    </div>
  );
}
