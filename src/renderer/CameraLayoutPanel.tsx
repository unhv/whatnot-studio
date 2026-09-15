import { useEffect, useRef, useState, type PointerEvent } from "react";
import { RealObsClient } from "../obs/client.js";
import type { ObsClient } from "../obs/client.js";
import {
  CAMERA_LAYOUT_COPY,
  CAMERA_LAYOUT_OBS_DEBOUNCE_MS,
  CameraLayoutObsSync,
  cameraLayoutReducer,
  cameraRects,
  CORNERS,
  INSET_SIZES,
  insetSizePx,
  loadCameraLayout,
  persistCameraLayout,
  safeRect,
  twoCamerasConfigured,
  WHATNOT_SAFE,
  type CameraLayout,
  type CameraLayoutAction,
  type CameraLayoutClock,
  type Corner,
  type InsetSize,
  type StorageLike,
} from "../state/cameraLayout.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../shared/types.js";
import { useAppStore } from "../state/store.js";

/** Same portrait box as the LIVE preview — large enough that the small
 *  camera is a 64px+ grab target, small enough to sit in the 520px window. */
export const LAYOUT_PREVIEW_W = 270;
export const LAYOUT_PREVIEW_H = 480;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function scaleX(n: number): number {
  return (n / CANVAS_WIDTH) * LAYOUT_PREVIEW_W;
}
function scaleY(n: number): number {
  return (n / CANVAS_HEIGHT) * LAYOUT_PREVIEW_H;
}

export default function CameraLayoutPanel(props: {
  client?: ObsClient;
  storage?: StorageLike | null;
  clock?: CameraLayoutClock;
  debounceMs?: number;
}) {
  const showConfig = useAppStore((s) => s.showConfig);
  const obsPort = showConfig.obsPort;
  const obsPassword = showConfig.obsPassword;
  const twoCameras = twoCamerasConfigured(showConfig);

  const storage = props.storage !== undefined ? props.storage : browserStorage();
  const [layout, setLayout] = useState<CameraLayout>(() => loadCameraLayout(storage));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const syncRef = useRef<CameraLayoutObsSync | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ grabX: number; grabY: number } | null>(null);
  const panelConnectedRef = useRef(props.client !== undefined);
  const [panelConnected, setPanelConnected] = useState(() => props.client !== undefined);

  useEffect(() => {
    let cancelled = false;
    const client = props.client ?? new RealObsClient();
    const owned = props.client === undefined;
    const connectedRef = panelConnectedRef;
    connectedRef.current = !owned;
    if (owned) setPanelConnected(false);

    const sync = new CameraLayoutObsSync({
      getClient: () => client,
      isConnected: () => connectedRef.current,
      getSourceNames: () => {
        const cfg = useAppStore.getState().showConfig;
        if (!twoCamerasConfigured(cfg) || !cfg.camera || !cfg.captureCard) return null;
        return {
          webcam: cfg.camera.label ?? "Camera",
          table: cfg.captureCard.label ?? "Table",
        };
      },
      debounceMs: props.debounceMs ?? CAMERA_LAYOUT_OBS_DEBOUNCE_MS,
      clock: props.clock,
      storage,
    });
    syncRef.current = sync;

    const onClosed = () => {
      connectedRef.current = false;
      if (!cancelled) setPanelConnected(false);
    };
    client.on("ConnectionClosed", onClosed);

    async function connectThenResync() {
      if (owned) {
        try {
          await client.connect(`ws://127.0.0.1:${obsPort}`, obsPassword);
        } catch {
          connectedRef.current = false;
          if (!cancelled) setPanelConnected(false);
          return;
        }
      }
      if (cancelled) return;
      connectedRef.current = true;
      setPanelConnected(true);
      sync.resync(layoutRef.current);
    }

    void connectThenResync();

    return () => {
      cancelled = true;
      client.off("ConnectionClosed", onClosed);
      connectedRef.current = false;
      syncRef.current = null;
      sync.dispose();
      if (owned) void client.disconnect();
    };
  }, [obsPort, obsPassword, props.client, props.clock, props.debounceMs, storage]);

  function apply(action: CameraLayoutAction): void {
    const next = cameraLayoutReducer(layoutRef.current, action);
    layoutRef.current = next;
    setLayout(next);
    persistCameraLayout(next, storage);
    syncRef.current?.notify(action, next);
  }

  function previewToCanvas(clientX: number, clientY: number): { x: number; y: number } | null {
    const el = previewRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  }

  function onInsetPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (layout.kind !== "inset") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const canvas = previewToCanvas(e.clientX, e.clientY);
    if (!canvas) return;
    dragRef.current = { grabX: canvas.x - layout.insetX, grabY: canvas.y - layout.insetY };
  }

  function onInsetPointerMove(e: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = previewToCanvas(e.clientX, e.clientY);
    if (!canvas) return;
    apply({ type: "MOVE_INSET", x: canvas.x - drag.grabX, y: canvas.y - drag.grabY });
  }

  function onInsetPointerUp(e: PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    apply({ type: "END_DRAG" });
  }

  const rects = cameraRects(layout);
  const insetKey = layout.main === "table" ? "webcam" : "table";
  const mainKey = layout.main;
  const inset = rects[insetKey];
  const { w: insetW, h: insetH } = insetSizePx(layout.insetSize);
  const safe = safeRect();
  const connected = panelConnected;

  const selectedBtn = "bg-amber-500 text-neutral-950";
  const idleBtn = "bg-neutral-800 text-neutral-100 hover:bg-neutral-700";

  return (
    <section
      className="flex flex-col gap-3 rounded-md bg-neutral-900 p-3 ring-1 ring-neutral-800"
      aria-label={CAMERA_LAYOUT_COPY.title}
    >
      <h2 className="text-lg font-semibold">{CAMERA_LAYOUT_COPY.title}</h2>

      {!twoCameras ? (
        <p className="rounded-md bg-neutral-950 px-3 py-3 text-sm text-neutral-300 ring-1 ring-neutral-800">
          {CAMERA_LAYOUT_COPY.missing}
        </p>
      ) : (
        <>
          {!connected ? (
            <p className="rounded-md bg-amber-950 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-800">
              {CAMERA_LAYOUT_COPY.disconnected}
            </p>
          ) : null}

          <div>
            <div className="mb-2 text-sm text-neutral-300">{CAMERA_LAYOUT_COPY.layout}</div>
            <div className="flex gap-2">
              <button
                type="button"
                className={`h-16 flex-1 rounded-md text-base font-semibold ${
                  layout.kind === "inset" ? selectedBtn : idleBtn
                }`}
                onClick={() => apply({ type: "SET_KIND", kind: "inset" })}
              >
                {CAMERA_LAYOUT_COPY.inset}
              </button>
              <button
                type="button"
                className={`h-16 flex-1 rounded-md text-base font-semibold ${
                  layout.kind === "split" ? selectedBtn : idleBtn
                }`}
                onClick={() => apply({ type: "SET_KIND", kind: "split" })}
              >
                {CAMERA_LAYOUT_COPY.split}
              </button>
            </div>
          </div>

          {layout.kind === "inset" ? (
            <div>
              <div className="mb-2 text-sm text-neutral-300">{CAMERA_LAYOUT_COPY.size}</div>
              <div className="flex gap-2">
                {INSET_SIZES.map((size: InsetSize) => (
                  <button
                    key={size}
                    type="button"
                    className={`h-16 flex-1 rounded-md text-base font-semibold ${
                      layout.insetSize === size ? selectedBtn : idleBtn
                    }`}
                    onClick={() => apply({ type: "SET_SIZE", size })}
                  >
                    {CAMERA_LAYOUT_COPY[size]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className="h-16 w-full rounded-md bg-neutral-800 text-base font-semibold text-neutral-100 hover:bg-neutral-700"
            onClick={() => apply({ type: "SWAP" })}
          >
            {layout.kind === "split" ? CAMERA_LAYOUT_COPY.swapSplit : CAMERA_LAYOUT_COPY.swap}
          </button>

          <div
            ref={previewRef}
            className="relative mx-auto overflow-hidden rounded-md bg-black ring-1 ring-neutral-700"
            style={{ width: LAYOUT_PREVIEW_W, height: LAYOUT_PREVIEW_H }}
            aria-label="Both cameras preview"
          >
            <div
              className="absolute bg-emerald-900/80"
              style={{
                left: scaleX(rects[mainKey].x),
                top: scaleY(rects[mainKey].y),
                width: scaleX(rects[mainKey].w),
                height: scaleY(rects[mainKey].h),
              }}
            >
              <span className="absolute left-2 top-2 text-xs font-semibold uppercase tracking-wide text-emerald-100">
                {mainKey === "table" ? "Table" : "Me"}
              </span>
            </div>

            {layout.kind === "split" ? (
              <div
                className="absolute bg-sky-900/80"
                style={{
                  left: scaleX(rects[insetKey].x),
                  top: scaleY(rects[insetKey].y),
                  width: scaleX(rects[insetKey].w),
                  height: scaleY(rects[insetKey].h),
                }}
              >
                <span className="absolute left-2 top-2 text-xs font-semibold uppercase tracking-wide text-sky-100">
                  {insetKey === "table" ? "Table" : "Me"}
                </span>
              </div>
            ) : (
              <div
                className="absolute cursor-grab bg-sky-700 ring-2 ring-amber-400 active:cursor-grabbing"
                style={{
                  left: scaleX(inset.x),
                  top: scaleY(inset.y),
                  width: scaleX(insetW),
                  height: scaleY(insetH),
                  touchAction: "none",
                }}
                onPointerDown={onInsetPointerDown}
                onPointerMove={onInsetPointerMove}
                onPointerUp={onInsetPointerUp}
                onPointerCancel={onInsetPointerUp}
              >
                <span className="absolute left-1.5 top-1.5 text-xs font-semibold uppercase tracking-wide text-white">
                  {insetKey === "table" ? "Table" : "Me"}
                </span>
              </div>
            )}

            <div
              className="pointer-events-none absolute left-0 right-0 top-0 bg-black/55"
              style={{ height: scaleY(WHATNOT_SAFE.top) }}
            />
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/55"
              style={{ height: scaleY(WHATNOT_SAFE.bottom) }}
            />

            {layout.kind === "inset"
              ? CORNERS.map((corner: Corner) => {
                  const cx = corner.endsWith("left")
                    ? scaleX(safe.x) + 4
                    : scaleX(safe.x + safe.w) - 12;
                  const cy = corner.startsWith("top")
                    ? scaleY(safe.y) + 4
                    : scaleY(safe.y + safe.h) - 12;
                  return (
                    <button
                      key={corner}
                      type="button"
                      aria-label={`Snap ${corner}`}
                      className="absolute h-3 w-3 rounded-full bg-amber-400/90 ring-2 ring-neutral-950"
                      style={{ left: cx, top: cy }}
                      onClick={() => apply({ type: "SNAP", corner })}
                    />
                  );
                })
              : null}
          </div>
        </>
      )}
    </section>
  );
}
