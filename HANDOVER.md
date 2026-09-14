# Handover — what still needs a real OBS

**OBS was never launched while building this.** Everything below is either a pure function
(tested, trustworthy) or a real request shape that is my best-effort reading of the
obs-websocket v5 protocol and what FINDINGS.md actually measured on this machine — not
something either of us has watched OBS accept. Treat every item here as a checklist for
the first supervised run, not a list of known bugs.

## Certain — measured in FINDINGS.md, safe to trust

- Crop-to-fill maths (`computeCropToFill`, reused via `src/obs/sceneCompiler.ts`) and the
  `boundsType: OBS_BOUNDS_NONE` + crop + scale request shape — check 4.
- `SetSceneItemTransform` field names (`cropLeft/Right/Top/Bottom`, `scaleX/Y`,
  `positionX/Y`) — check 4.
- `text_gdiplus_v3` input kind and its `text` settings key, live-updatable via
  `SetInputSettings` — check 5. Used for the BREAK card and (once wired — see below) the
  item bar's on-canvas lower third.
- `GetSourceScreenshot` is cheap at 2–5fps — check 6. The LIVE screen's preview box is
  currently a placeholder; polling it in was not wired (see "Not yet wired" below).
- Cut and 300ms Fade transitions are both usable with zero setup — check 7.
- A passive websocket client reliably learns `outputActive`/`outputState` changes without
  driving the output itself — check 1 (measured via `VirtualcamStateChanged`, inferred for
  `StreamStateChanged` — HQ's own caveat in FINDINGS.md flags this inference explicitly;
  confirm against a real Whatnot show before trusting it fully).
- The canvas-restart quirk (`SetVideoSettings` sticks after a full restart) — check 3.
  `src/obs/firstRun.ts` bakes this in.

## Needs verification — best-effort, unverified against real OBS

1. **The scene-collection JSON skeleton** (`buildSceneCollectionSkeleton` in
   `src/obs/firstRun.ts`) has never been loaded by OBS. It's modelled on the public
   obs-studio scene-collection format (one placeholder "Scene", `current_scene`,
   `scene_order`, etc.) but the exact required fields for OBS 31.x to accept a
   hand-written file were never confirmed — that's exactly the check this task couldn't
   run. **If OBS rejects it or falls back to `Untitled`**, the fallback is: launch OBS
   once on whatever it defaults to, then create the profile/collection over the websocket
   with `CreateProfile`/`CreateSceneCollection` (obs-websocket v5 requests that were never
   exercised in the spike either) instead of pre-writing files.
2. **`--profile`/`--collection` picking up freshly-written files.** FINDINGS check 2 only
   proved that these flags don't *create* a profile/collection that doesn't exist — it
   never tested them against files this app wrote moments before launch. The first
   supervised run needs to confirm OBS actually selects them rather than falling back to
   `Untitled` again for some other reason (e.g. a missing key the skeleton doesn't have).
3. **`GetProfileList`/`GetSceneCollectionList` response field names** — used in
   `src/obs/firstRun.ts` as `{ currentProfileName }` / `{ currentSceneCollectionName }`
   per the obs-websocket v5 spec from memory. Not exercised in the spike (which never ran
   these calls) or in this build. If the real field names differ, `verifyProfileAndCollection`
   will report a false mismatch and correctly refuse to continue — safe failure mode, but
   worth fixing rather than living with a permanent stop.
4. **`CreateInput`'s `sceneName` requirement** (`src/obs/applyPlan.ts`) — obs-websocket v5's
   `CreateInput` takes a target scene and, per its docs, also adds a scene item to that
   scene as a side effect. This code passes the first desired scene as that target and then
   separately issues `CreateSceneItem` for every scene (including that first one) — which
   may create a **duplicate** scene item in whichever scene was used as `CreateInput`'s
   target. `readCurrentObsState` re-reading before every compile should self-correct this on
   the next run (the duplicate would just show up as an extra item to reconcile), but it was
   never watched happen. Worth a dedicated look in the first supervised run.
5. **`dshow_input` settings key `video_device_id`** (`src/obs/sceneCompiler.ts`) — the
   Windows DirectShow source's settings field name, from memory of the OBS source schema,
   not confirmed against this machine's actual OBS/plugin versions.
6. **`SetInputSettings`/mixer request shapes for mic mute** — not implemented at all yet
   (see below), so nothing to verify, but `SetInputMute` is the obvious candidate and
   wasn't exercised anywhere in the spike.

## Not yet wired — real logic exists, OBS calls do not

The LIVE screen's buttons currently only update the Zustand store; **none of them call
into OBS yet**. This was a scope call to stay inside "no OBS launch" — the compiler,
first-run flow and item-bar state machine are all real and tested, but connecting them to
a live OBS instance needs the supervised run to iterate against real responses. Specifically:

- Scene tile clicks (ME/TABLE/BOTH/BREAK) don't yet call `SetCurrentProgramScene`, and
  BREAK's "mic muted" behaviour (brief: "BREAK — BRB card, mic muted") isn't coupled to
  the mute toggle at all — that coupling belongs in the LIVE screen's scene-switch handler
  once OBS is wired in.
- The fade-vs-cut transition selection (300ms fade into/out of BREAK, straight cut
  otherwise) is not applied — `SetCurrentSceneTransition`/`SetCurrentSceneTransitionDuration`
  need to be called around the scene switch.
- The item bar's Enter/SHOW/CLEAR/SOLD actions update `itemBar` state correctly (tested)
  but don't yet push `SetInputSettings`/`SetSceneItemEnabled` to the on-canvas text source.
- The mic MUTE toggle only flips local UI state; no `SetInputMute` call.
- The preview box is a static placeholder; polling `GetSourceScreenshot` at 2–4fps
  (confirmed cheap) into an `<img>` is not implemented.
- Device enumeration for the Setup screen's three dropdowns is not implemented — the
  dropdowns render correctly with an empty list ("No devices detected") but nothing calls
  OBS to populate them. The obvious approach is `GetInputPropertiesListPropertyItems` on a
  scratch `dshow_input`, per obs-websocket v5's docs, but that was never exercised here.
  Live thumbnails on the Setup screen have the same gap.
- `runFirstRunSetup` (src/obs/firstRun.ts) is written, fully unit-tested against fakes,
  and never called from `electron/main.ts` or the renderer yet — there is no "first run"
  trigger wired into the app's actual startup path. The Setup screen's "Continue" button
  currently just flips `screen` to `"live"`.
- The "Reconnect" button (brief's crash-recovery substitute, since there's no
  installer/auto-update) is not built.
- Whatnot's Show Tools URL in `SetupScreen.tsx`'s "Open Whatnot Show Tools" button
  (`https://www.whatnot.com/dashboard/livestream/setup`) is a guess, not a confirmed URL.

## Suggested order for the supervised run

1. Launch OBS manually once, confirm `GetProfileList`/`GetSceneCollectionList`'s real
   field names against what `src/obs/firstRun.ts` expects.
2. Run `runFirstRunSetup` for real against a throwaway profile name (not "Whatnot Studio"
   — keep it off the user's real setup until the flow is trusted), watch whether OBS
   accepts the hand-written scene-collection file or falls back to `Untitled`.
3. Wire `syncScenes` (`src/obs/applyPlan.ts`) in and watch the four scenes get created —
   check specifically for the `CreateInput` duplicate-item risk in item 4 above.
4. Wire scene switching, mic mute, item bar, and the preview poll into the LIVE screen one
   at a time, each against the now-verified request shapes.
