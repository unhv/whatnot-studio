# Handover — what still needs a real OBS

Most of what this file used to list as "best-effort, unverified" was verified live against real
OBS during the 2026-09-15 supervised run (see `FINDINGS.md`'s dated sections for the evidence).
This file is now trimmed to only what genuinely remains unverified or unwired. If you're picking
this up: read `FINDINGS.md` first for what's already been measured, especially the "hard problem"
section on OBS-minimized-to-tray not being gracefully closeable — that's a real, documented product
gap, not a guess.

## Still needs verification against real OBS

1. **`dshow_input` settings key `video_device_id`** (`src/obs/sceneCompiler.ts`) — the Windows
   DirectShow source's settings field name, from memory of the OBS source schema, still not
   confirmed against this machine's actual OBS/plugin versions. Blocks device enumeration below.
2. **`SetInputMute`/mixer request shape for mic mute** — never exercised live. `SetInputMute` is
   the obvious candidate (obs-websocket v5 docs) but wasn't called against real OBS this session.
3. **`GetInputPropertiesListPropertyItems`** for populating the Setup screen's device dropdowns —
   never exercised live. This is the blocking gap for device enumeration and live thumbnails.
4. **OBS 32.x version warning** (`checkObsVersionWarning` in `src/obs/firstRun.ts`) — implemented
   and unit-tested, and the read+wiring path (`GetVersion` → `versionWarning` on `FirstRunResult`)
   was live-verified on this machine's OBS 31.1.2 (returns `undefined`, as expected). The actual
   `/^32\./` warning branch itself was never exercised against a real 32.x OBS build, because none
   was available.

## Known, unresolved product gap (not a guess — measured)

**There is no way for this app to cleanly shut down its managed OBS instance once OBS has been
minimized to tray**, which `--minimize-to-tray` requires enabling (`SysTrayEnabled=true` governs
both tray-minimize and close-to-tray — there's no separate flag). `taskkill /PID` (no `/F`) is
silently swallowed; OBS's own hotkey system has no Quit/Exit action at all. Confirmed over 80+
seconds with zero log activity. See FINDINGS.md's "hard problem" section for full evidence,
including the correction of an earlier claim of success that turned out to have been a masked
force-kill. Worth its own follow-up brief; one untested candidate is toggling `SysTrayEnabled` off
in `global.ini` around a deliberate app-initiated shutdown.

## Not yet wired — real logic exists, OBS calls do not

The LIVE screen's buttons still only update the Zustand store; none of them call into OBS yet.
`runFirstRunSetup` IS now wired into the Setup screen's Continue button (`src/obs/runSetup.ts`),
so this list is narrower than it used to be:

- Scene tile clicks (ME/TABLE/BOTH/BREAK) don't yet call `SetCurrentProgramScene`, and BREAK's
  "mic muted" behaviour isn't coupled to the mute toggle at all.
- The fade-vs-cut transition selection (300ms fade into/out of BREAK, straight cut otherwise) is
  not applied — needs `SetCurrentSceneTransition`/`SetCurrentSceneTransitionDuration` around the
  scene switch. (Cut and 300ms Fade transitions were confirmed usable with zero extra setup in the
  original spike — this is a wiring gap, not an unknown.)
- The item bar's Enter/SHOW/CLEAR/SOLD actions update `itemBar` state correctly (tested) but don't
  yet push `SetInputSettings`/`SetSceneItemEnabled` to the on-canvas text source.
- The mic MUTE toggle only flips local UI state; no `SetInputMute` call (see item 2 above).
- The preview box is a static placeholder; polling `GetSourceScreenshot` at 2–4fps (confirmed
  cheap in the original spike) into an `<img>` is not implemented.
- Device enumeration for the Setup screen's three dropdowns is not implemented — the dropdowns
  render correctly with an empty list ("No devices detected") but nothing calls OBS to populate
  them (see item 3 above). Live thumbnails on the Setup screen have the same gap.
- The "Reconnect" button (brief's crash-recovery substitute, since there's no installer/auto-update)
  is not built.
- The OBS websocket password is currently plain JSON in the show config — it needs to go through
  Electron's `safeStorage` (secret, never logged, never plain JSON) before this ships for real use.

## Suggested order for the next supervised session

1. Confirm `dshow_input`'s `video_device_id` and wire device enumeration
   (`GetInputPropertiesListPropertyItems`) + live thumbnails into the Setup screen.
2. Wire scene switching, transitions, mic mute, and the item bar's on-canvas push into the LIVE
   screen, each against a real OBS connection, each with a unit test against `FakeObsClient`.
3. Wire the preview poll (`GetSourceScreenshot`) into the LIVE screen's preview box.
4. Move the OBS websocket password to `safeStorage`.
5. Take on the tray-close product gap as its own piece of work.
