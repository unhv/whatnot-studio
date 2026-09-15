import React from "react";
import ReactDOM from "react-dom/client";
import CameraLayoutPanel from "./CameraLayoutPanel.js";
import "./index.css";
import { useAppStore } from "../state/store.js";
import {
  cameraLayoutReducer,
  cameraRects,
  DEFAULT_CAMERA_LAYOUT,
  WHATNOT_SAFE,
  type CameraLayout,
} from "../state/cameraLayout.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../shared/types.js";

useAppStore.setState({
  connectionStatus: "connected",
  showConfig: {
    ...useAppStore.getState().showConfig,
    camera: { deviceId: "cam-1", label: "Webcam" },
    captureCard: { deviceId: "cap-1", label: "Capture Card" },
  },
});

const split = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_KIND", kind: "split" });
const swapped = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SWAP" });
const large = cameraLayoutReducer(DEFAULT_CAMERA_LAYOUT, { type: "SET_SIZE", size: "large" });

function Board(props: { id: string; title: string; layout: CameraLayout }) {
  const rects = cameraRects(props.layout);
  return (
    <div className="mb-8">
      <div className="mb-2 text-lg font-semibold">{props.title}</div>
      <div
        id={props.id}
        className="relative bg-neutral-950"
        style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
      >
        <div
          className="absolute bg-emerald-800"
          style={{
            left: rects.table.x,
            top: rects.table.y,
            width: rects.table.w,
            height: rects.table.h,
          }}
        >
          <span className="absolute left-8 top-8 text-5xl font-bold text-emerald-50">TABLE</span>
        </div>
        <div
          className="absolute bg-sky-700 ring-8 ring-amber-400"
          style={{
            left: rects.webcam.x,
            top: rects.webcam.y,
            width: rects.webcam.w,
            height: rects.webcam.h,
          }}
        >
          <span className="absolute left-8 top-8 text-5xl font-bold text-white">ME</span>
        </div>
        <div
          className="pointer-events-none absolute left-0 right-0 top-0 bg-black/40"
          style={{ height: WHATNOT_SAFE.top }}
        />
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/40"
          style={{ height: WHATNOT_SAFE.bottom }}
        />
      </div>
    </div>
  );
}

function Shots() {
  return (
    <div>
      <div id="control" className="flex w-[520px] flex-col gap-4 bg-neutral-950 p-4">
        <CameraLayoutPanel />
      </div>
      <div className="mt-16">
        <Board id="layout-inset" title="Inset — table big, me small" layout={DEFAULT_CAMERA_LAYOUT} />
        <Board id="layout-large" title="Inset — large" layout={large} />
        <Board id="layout-swapped" title="Inset — me big" layout={swapped} />
        <Board id="layout-split" title="Split" layout={split} />
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Shots />
  </React.StrictMode>
);
