# Whatnot Studio

A single-window Electron app that owns OBS picture and sound for a Whatnot seller — so
someone who has never opened OBS can get a portrait, overlaid PC stream out through
Whatnot's own Show Tools page, and stay live for an hour without ever touching OBS.

## What it does

- **Setup screen**: pick a camera, mic and optional capture card, name the show, copy the
  OBS websocket password, and open Whatnot's Show Tools page.
- Creates and idempotently maintains four OBS scenes from a JSON data model — **ME**,
  **TABLE**, **BOTH**, **BREAK** — each cropped-to-fill the 1080x1920 canvas (no
  letterboxing), named by seller intent rather than by raw OBS names.
- **LIVE screen**: a status strip, a portrait preview, the four scene tiles (straight cut
  between ME/TABLE/BOTH, a 300ms fade into/out of BREAK), an item bar with a SOLD button,
  and a mic mute toggle. Global hotkeys F1–F4 switch scenes and F5 is SOLD, because
  keyboard focus normally lives in the seller's browser tab, not this window.

## What it does not do

- **It has no Go Live button, and never will.** Whatnot's own Show Tools page owns Go
  Live; this app only ever listens for OBS's `StreamStateChanged` event and reflects
  LIVE / NOT LIVE. No code path in `src/` writes OBS's stream-service config or passes
  the CLI flag that forces a stream to start on launch — that's enforced by convention
  (see the comment at the top of `src/obs/client.ts`) and provable by grep.
- No music playback (deliberately — see the brief; it's also a copyright-strike risk to a
  seller's account), no per-app audio capture, no mic ducking, no chat overlay, no
  Whatnot API calls, no recording, no multi-platform, no macOS/Linux, no bundling OBS, no
  installer/auto-update/crash-recovery. Ship a zip; there's a "Reconnect" button for the
  websocket connection instead.

## How to run

```
npm install
npm test            # pure-logic unit tests — no OBS required, none is ever launched
npm run build        # renderer (Vite) + main/preload (tsc) -> dist/, dist-electron/
npm start             # electron .  (loads dist/index.html via dist-electron/electron/main.js)
```

For renderer development with hot reload, run `npm run dev:renderer` in one terminal and
set `VITE_DEV_SERVER_URL` before `npm start` in another.

**This build was produced without ever launching OBS** (see `HANDOVER.md`). The
OBS-attached parts — device enumeration, the live preview, the first-run scene-collection
file, and the actual scene compiler applied against a real OBS — need a supervised run
before they can be trusted.

## Architecture, briefly

- `src/obs/client.ts` — the injectable `ObsClient` interface + a real `obs-websocket-js`
  implementation. Every other OBS-touching module takes an `ObsClient`, never the library
  directly, which is what makes them unit-testable without OBS.
- `src/obs/sceneCompiler.ts` — pure: (desired scenes, current OBS state) → ops. Compiling
  twice against the same inputs is deterministic; applying ops then recompiling converges
  to zero ops.
- `src/obs/applyPlan.ts` — the only place compiled ops turn into real `ObsClient.call`s.
- `src/obs/firstRun.ts` — create-then-verify: write the profile/collection files, launch,
  verify OBS actually came up on them (a mismatch is a stop condition, not a warning), set
  the canvas, restart.
- `src/state/itemBar.ts` — the item-bar / SOLD state machine, pure.
- `src/state/store.ts` — the one Zustand store (one window, no router).
- `src/renderer/` — the two screens.
- `electron/` — main process (OBS process launch/close, first-run file writes, global
  hotkeys) and preload (contextBridge).
- `spike/lib.ts` and `spike/obs-launcher.ts` are reused as-is (not scaffolding to discard)
  — see `FINDINGS.md` for what they were built to prove.
