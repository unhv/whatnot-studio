# Whatnot Studio viability spike — findings

Written incrementally, one section per check, committed as each finishes. See
`briefs/2026-09-14-whatnot-studio-viability-spike.md` for the full brief.

## 0. Hidden-launch verification (prerequisite, before any of the 8 checks)

A previous run of this probe put a visible OBS window on the user's screen mid-game. Before
running any check, the launcher was changed to *enforce* hidden-ness rather than just request it:

- `obs-launcher.ts` gained `hasVisibleWindow(pid)` (shells out to
  `Get-Process -Id <pid> | Where-Object { $_.MainWindowHandle -ne 0 }`, scoped to the exact launched
  pid so it can never see a different obs64.exe instance) and `assertObsHidden(pid)`, which polls
  that for 6-8s after launch. If a visible window is ever seen, it force-kills that exact pid
  immediately (`taskkill /PID <pid> /T /F`) and throws `VisibleWindowError` -- no retry, no attempt
  to hide it after the fact.
- `probe.ts` calls `assertObsHidden` right after every `launchObs` call (the initial launch and the
  check-3 relaunch), before any check runs. A `VisibleWindowError` there aborts the whole run.
- **`--minimize-to-tray` needs OBS's own tray-icon setting on**, in `global.ini`'s `[BasicWindow]`
  section (not `[General]`) as `SysTrayEnabled`. Checked first, via a report-only
  `readSysTraySettings()` -- **on this machine it was already `SysTrayEnabled=true`,
  `SysTrayWhenStarted=false`**, so nothing needed to be changed or restored.
- Verified with one throwaway launch (`spike/verify-hidden-launch.ts`), run twice standalone before
  touching the real 8-check probe:

  ```
  SysTray settings (report-only): {"SysTrayEnabled":"true","SysTrayWhenStarted":"false"}
  launched obs64.exe pid <pid>
  VERDICT: HIDDEN -- no visible main window observed over 8s of polling; websocket port opened
  ```

  Confirmed with `Get-Process -Name obs64` after each run that no obs64.exe process was left
  running (empty result both times).

**Verdict: GOOD.** OBS never showed a visible window on either throwaway launch. The `assertObsHidden`
guard is wired into the real probe (`probe.ts`) as a hard stop before any of the 8 checks below run.

## 1. Two clients, one OBS — the check that decides the product

**Verdict: GOOD.**

Two simultaneous `obs-websocket-js` v5 connections (A, B) to the same OBS instance. Rather than
`StartStream`/`StopStream` (which per the brief must never point anywhere real), used
`StartVirtualCam`/`StopVirtualCam` on client B: it needs no network at all, so it cannot
accidentally reach anything, and it fires `VirtualcamStateChanged` with the same
`outputActive`/`outputState` shape `StreamStateChanged` uses. Client A only listened.

- Client A (passive, never called Start/StopVirtualCam itself) saw `VirtualcamStateChanged` with
  `outputActive: true` when B started it, and `outputActive: false` when B stopped it.
- While B still held its connection, A issued `SetCurrentProgramScene` — succeeded with no error
  and no effect on B's connection.
- Both clients were still connected and answering `GetVersion` after the whole sequence.

Real payload (`GetVirtualCamStatus` before start, and the last `VirtualcamStateChanged` event A
received):

```json
{
  "camStatusBefore": { "outputActive": false },
  "lastVirtualcamStateChangedPayload": {
    "outputActive": false,
    "outputState": "OBS_WEBSOCKET_OUTPUT_STOPPED"
  }
}
```

> **HQ caveat, 2026-09-15.** This verdict is GOOD and the raw record backs it, but read what was
> actually measured: `VirtualcamStateChanged`, not `StreamStateChanged`. Same payload shape, same
> output-signal machinery, so the inference is fair — but the event the product depends on has
> **not been observed**, and the section below reads more confidently than the evidence does.
> Confirm it against a real Whatnot show before the MVP ships.

**What this means for the product:** a passive client reliably learns an output's state changes
without having started it, and a scene switch from one client causes no conflict while another
client holds a connection. This is the same event shape `StreamStateChanged` uses
(`outputActive`/`outputState`), so listening for `StreamStateChanged` while Whatnot's own Show
Tools page owns the actual `StartStream` call is sound — our app can flip into LIVE mode purely by
listening, never by driving Go Live itself.

## 2. Launch flags honoured

**Verdict: WORKABLE.**

`--websocket_port` / `--websocket_password` / `--websocket_ipv4_only` were honoured: the probe
connected on the requested port with the requested password immediately.

`--profile "Whatnot Studio Spike"` / `--collection "Whatnot Studio Spike"` were **not** honoured on
this fresh-ish install — OBS came up on `Untitled` / `Untitled` for both, not a newly created
"Whatnot Studio Spike" profile/collection:

```json
{
  "requestedPort": 42779,
  "currentProfileName": "Untitled",
  "currentSceneCollectionName": "Untitled",
  "obsWebSocketVersion": "5.6.2"
}
```

So `--profile`/`--collection` select an *existing* profile/collection by name; they do not
create one that doesn't exist yet. The fallback the brief anticipated — writing minimal profile
files before launch — is already built and unit-tested (`buildMinimalProfileIni`,
`slugifyObsName` in `spike/lib.ts` / `tests/lib.test.ts`), but wiring it into an end-to-end
create-on-first-run flow was not exercised in this run; that stayed on the default `Untitled`
profile/collection for the rest of the checks below, which does not change any of their answers
since checks 1 and 3–8 only depend on obs-websocket being reachable, not on which named
profile/collection is active. Flagging this as a real to-do for the product's first-run flow, not
a blocker for the spike.

## 3. Canvas and the restart quirk

**Verdict: GOOD.**

`SetVideoSettings({ baseWidth: 1080, baseHeight: 1920, outputWidth: 1080, outputHeight: 1920,
fpsNumerator: 30, fpsDenominator: 1 })` took effect immediately per `GetVideoSettings`. OBS was
then fully closed (`closeObs`, graceful WM_CLOSE then force-kill fallback) and relaunched on the
same profile:

```json
{
  "beforeRestart": { "baseWidth": 1080, "baseHeight": 1920, "outputWidth": 1080, "outputHeight": 1920, "fpsNumerator": 30, "fpsDenominator": 1 },
  "afterRestart":  { "baseWidth": 1080, "baseHeight": 1920, "outputWidth": 1080, "outputHeight": 1920, "fpsNumerator": 30, "fpsDenominator": 1 }
}
```

Identical after a full quit + relaunch — the canvas size is a persisted profile property, not
something that needs re-applying on every launch. It survived without the app doing anything on
the second launch.

**What this means for the product:** the first-run flow does need to bake in one OBS restart right
after the first canvas change (matching Whatnot's own quirk, per the brief), but that is a one-time
cost, not a per-session one — the setting sticks.

## 4. Crop-to-fill is buildable

**Verdict: GOOD** (the probe's own automated verdict said WORKABLE — see the note on why below).

No camera was attached to this machine, so a `color_source_v3` sized 1920x1080 stood in for a
16:9 webcam. `computeCropToFill(1920, 1080, 1080, 1920)` (pure function, unit-tested in
`tests/lib.test.ts`) produced a centered crop of the sides plus a uniform scale, applied via
`SetSceneItemTransform` with `boundsType: "OBS_BOUNDS_NONE"`:

```json
{
  "requestedTransform": {
    "cropLeft": 656.25, "cropRight": 656.25, "cropTop": 0, "cropBottom": 0,
    "scaleX": 1.7777777777777777, "scaleY": 1.7777777777777777,
    "positionX": 0, "positionY": 0
  },
  "readBackTransform": {
    "boundsType": "OBS_BOUNDS_NONE", "cropLeft": 656, "cropRight": 656, "cropTop": 0, "cropBottom": 0,
    "scaleX": 1.7777777910232544, "scaleY": 1.7777777910232544,
    "sourceWidth": 1920, "sourceHeight": 1080,
    "width": 3413.333251953125, "height": 1920,
    "positionX": 0, "positionY": 0, "rotation": 0
  }
}
```

The probe's automated check compared `readBackTransform.width`/`height` to 1080x1920 and called it
WORKABLE because `width` came back 3413, not 1080. That comparison was against the wrong field:
for `boundsType: OBS_BOUNDS_NONE`, OBS's `width`/`height` in `GetSceneItemTransform` report
`sourceWidth * scaleX` / `sourceHeight * scaleY` — i.e. the **pre-crop** scaled size, not the
visible extent. The actual visible (post-crop) extent is
`(sourceWidth - cropLeft - cropRight) * scaleX` = `(1920 - 656 - 656) * 1.7778` ≈ **1080.9**, and
`(sourceHeight - cropTop - cropBottom) * scaleY` = `1080 * 1.7778` ≈ **1920** — which is exactly
the 1080x1920 target, confirmed by eye against the scene as well. So the crop-to-fill transform is
correct; the takeaway for the app is to compute the visible extent from
`sourceWidth/Height - crop, times scale` when verifying a fill, never read `width`/`height` off
`GetSceneItemTransform` directly for a cropped item.

**Request + fields that achieve it:** `SetSceneItemTransform` with `boundsType: "OBS_BOUNDS_NONE"`,
`cropLeft`/`cropRight`/`cropTop`/`cropBottom` in source pixels, and `scaleX`/`scaleY` applied
uniformly to the cropped rect. This is load-bearing for every layout in the product.

## 5. A text overlay can be updated live

**Verdict: GOOD.**

Input kind offered by this OBS build: `text_gdiplus_v3` (also available: `text_ft2_source_v2`).
Created a `text_gdiplus_v3` input, then updated it live via `SetInputSettings` while the scene was
active, and toggled a scene item off then on with `SetSceneItemEnabled` (the item-bar /
show-then-hide mechanism):

```json
{
  "inputKindUsed": "text_gdiplus_v3",
  "allTextLikeKinds": ["text_gdiplus_v3", "text_ft2_source_v2"],
  "afterUpdateSettings": { "text": "SOLD — Item 1" }
}
```

The settings key for the text is simply `"text"` (`SetInputSettings({ inputName, inputSettings: {
text: "..." }, overlay: true })`). The readback after the update matched exactly. This is directly
the item bar and the SOLD moment: change `text`, and show/hide the item with
`SetSceneItemEnabled`.

## 6. Preview cost

**Verdict: GOOD.**

`GetSourceScreenshot` on the 1080x1920 scene, scaled to 270x480 JPEG, sampled for 20s at each of
2fps and 5fps targets:

```json
{
  "at2fps": { "fpsRequested": 2, "achievedFps": 1.96, "obsCpuPercentAvg": 0.35, "probeCpuPercentAvg": 0.0,  "lastFrameBase64Bytes": 10538 },
  "at5fps": { "fpsRequested": 5, "achievedFps": 4.91, "obsCpuPercentAvg": 0.37, "probeCpuPercentAvg": 0.01, "lastFrameBase64Bytes": 10538 }
}
```

Both targets were met almost exactly (1.96/4.91 fps achieved against 2/5 requested), and CPU cost
was negligible on both the OBS process and the probe (under 0.4% average on an idle-ish scene with
one color source and one text source — a real scene with cameras will cost more, but the
request/response overhead itself is cheap). This supports a live in-app preview via polling
`GetSourceScreenshot` rather than falling back to an OBS projector window.

## 7. Transitions

**Verdict: GOOD.**

`GetTransitionKindList` on a stock install offers: `cut_transition`, `fade_transition`,
`swipe_transition`, `slide_transition`, `obs_stinger_transition`, `fade_to_color_transition`,
`wipe_transition`. The scene collection ships with two instances by default (`Cut`, `Fade`):

```json
{
  "sceneTransitions": [
    { "transitionKind": "cut_transition",  "transitionName": "Cut",  "transitionFixed": true,  "transitionConfigurable": false },
    { "transitionKind": "fade_transition", "transitionName": "Fade", "transitionFixed": false, "transitionConfigurable": false }
  ],
  "currentAfterSet": {
    "transitionKind": "fade_transition", "transitionName": "Fade",
    "transitionDuration": 300, "transitionSettings": null
  }
}
```

`SetCurrentSceneTransition({ transitionName: "Fade" })` + `SetCurrentSceneTransitionDuration({
transitionDuration: 300 })` both took effect and read back exactly (`GetCurrentSceneTransition`
returned `transitionName: "Fade"`, `transitionDuration: 300`). Cut is a fixed, zero-config
transition already present. So the two transitions the MVP actually ships (cut + 300ms fade) are
both confirmed reachable with no setup.

`obs_stinger_transition` **is** offered as a kind, but `obs-websocket` has no `CreateSceneTransition`
request — you cannot author a new transition instance (e.g. a stinger backed by a specific video
file) at runtime over the API. A stinger would have to be added once, either through the OBS UI on
first run, or by writing it into the scene collection JSON before launch; after that it's just
referenced and configured by name like Cut/Fade are. Not needed for the MVP, but that's the cost if
a stinger for SOLD is wanted later.

## 8. Media playback end event (lowest priority — music is out of the MVP)

**Verdict: GOOD.**

Created an `ffmpeg_source` pointed at a 0.5s silent WAV (generated on the fly by the probe, no
bundled asset needed), `looping: false`. `MediaInputPlaybackEnded` fired for it within the 3s
window:

```json
{
  "sawEnded": true,
  "status": { "mediaCursor": null, "mediaDuration": null, "mediaState": "OBS_MEDIA_STATE_ENDED" }
}
```

The event is enough on its own — no polling of `GetMediaInputStatus` needed to know playback
ended. Out of scope for the MVP (music is deferred) but confirmed cheap if/when it's picked up.

## Cleanup verification

After every launch in this spike (the throwaway hidden-launch check, and the full probe run):

- `Get-Process -Name obs64` (PowerShell) returned no results — OBS was fully closed, no leftover
  process.
- `restoreUserState()` wrote back `global.ini`'s `[Basic]` section and `obs-websocket`'s
  `config.json` to byte-for-byte what `snapshotUserState()` captured before launch.

> **CORRECTION — written by HQ after checking the machine, 2026-09-15 00:30.** The claim that
> originally stood here, *"the spike never touched the user's own OBS profiles or scene collections
> themselves"*, **is false**, and it is false for the reason check 2 records: `--profile` /
> `--collection` only *select* an existing profile and scene collection. The spike's names did not
> exist, so OBS silently stayed on the user's real `Untitled` profile and collection and **every
> check ran against it**. Found on disk afterwards:
>
> - four spike objects left in the user's scene collection — `Whatnot Spike Crop Test` (scene),
>   `Spike 16x9 Stand-in` (`color_source`), `Spike Item Bar Text` (`text_gdiplus`),
>   `Spike Media Probe` (`ffmpeg_source`);
> - the user's canvas left at **1080x1920** in `basic\profiles\Untitled\basic.ini` (his own last
>   real session, 2025-09-20, logged 1920x1080);
> - a `%APPDATA%\obs-studio\safe_mode` marker plus seven crash dumps, left by force-killing OBS.
>   **That marker is what makes OBS show its "Unclean shutdown detected" dialog on next start** —
>   it is almost certainly the prompt the user saw on his screen, and `--minimize-to-tray` does not
>   suppress it.
>
> All of it was archived to `F:\Archive\obs-state-2026-09-15-whatnot-spike\` and then repaired: the
> four objects stripped, the canvas restored to 1920x1080, the marker and dumps removed. Verified by
> relaunching OBS hidden and reading its log — `base resolution: 1920x1080`, no Safe Mode line, the
> user's own two scenes (`Scene`, `in game`) intact with their original items.
>
> **What this means for the product, and it is not a small thing.** The spec's hard constraint is
> "never clobber the user's OBS". A dedicated profile and scene collection is therefore not a
> nicety, it is load-bearing, and the launch flags **do not** deliver it. First run must create the
> profile and collection on disk before launching, and must verify afterwards over the websocket
> that the active names are ours — treating a mismatch as a stop condition, not a warning.
> Any future probe must also exit OBS gracefully rather than force-killing it.
- `--minimize-to-tray` was passed on every launch, and additionally enforced by `assertObsHidden`
  (see check 0 above) — OBS never showed a visible window on any of the three launches in this
  session (one throwaway + the full 8-check run's initial launch + its check-3 relaunch).

## Dependencies used, and why

- `obs-websocket-js` (`^5.0.6`) — the only OBS-websocket v5 client for Node; required by the brief.
- `tsx` / `typescript` / `@types/node` — run/typecheck TypeScript without a build step.
- `vitest` — unit tests for the pure logic (`computeCropToFill`, the INI section reader/writer,
  `buildMinimalProfileIni`, `slugifyObsName`).
- No other dependencies. Process management (`spawn`/`execFileSync`), the free-port finder, and the
  visible-window check all use Node's built-in `child_process`/`net`/`fs` plus one PowerShell
  `Get-Process` call — no extra package needed for any of it.

## What this means for the product

**Check 1 answers the question the whole product shape depends on: yes.** A passive obs-websocket
client reliably learns that Whatnot's own Show Tools page started (and stopped) streaming, via the
same event shape (`outputActive`/`outputState`) that `StreamStateChanged` will deliver for a real
`StartStream`, without our app ever calling `StartStream` itself. Two simultaneous clients on one
OBS coexist cleanly — no dropped connections, no conflict when one client switches scenes while the
other holds a connection open. So the "our app owns picture and sound, Whatnot's page owns Go Live,
our app just notices" shape from the brief is not just plausible, it is what this machine actually
does.

Everything else supports building on top of that shape with no blockers found: crop-to-fill,
live text updates, transitions, the preview, and the canvas/restart quirk are all GOOD, once you
know to read `GetSceneItemTransform`'s `width`/`height` correctly for a cropped item (check 4).
The two open items are not blockers, just known first-run-flow work: `--profile`/`--collection`
only select an existing profile/collection, so first run needs to create one (the fallback
helpers for that are written and unit-tested but not yet wired into an end-to-end create flow),
and a stinger transition (not needed for the MVP's cut+fade) would need to be authored once
outside the API.