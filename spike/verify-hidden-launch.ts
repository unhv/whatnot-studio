/**
 * One throwaway launch to prove the hidden-launch behaviour BEFORE any of
 * the 8 numbered checks run. Launches OBS with the spike profile, polls for
 * a visible main window, and always cleans up. Exits non-zero and prints
 * BLOCKED if a window ever appears — per the brief, no retry.
 */
import {
  launchObs,
  waitForPort,
  closeObs,
  assertObsHidden,
  readSysTraySettings,
  snapshotUserState,
  restoreUserState,
  ensureWebsocketServerEnabled,
  VisibleWindowError,
} from "./obs-launcher.js";

async function main() {
  const port = 61999;
  const password = "verify-hidden-launch-pw";

  const sysTray = await readSysTraySettings();
  console.log("SysTray settings (report-only):", JSON.stringify(sysTray));

  const snapshot = await snapshotUserState();
  await ensureWebsocketServerEnabled();

  const launch = launchObs({ port, password });
  console.log("launched obs64.exe pid", launch.pid);

  let verdict: "HIDDEN" | "BLOCKED" | "ERROR" = "ERROR";
  let detail = "";

  try {
    await assertObsHidden(launch.pid, 8000, 500);
    verdict = "HIDDEN";
    detail = "no visible main window observed over 8s of polling";
    try {
      await waitForPort(port, "127.0.0.1", 30000);
      detail += "; websocket port opened";
    } catch (e) {
      detail += `; websocket port never opened: ${(e as Error).message}`;
    }
  } catch (e) {
    if (e instanceof VisibleWindowError) {
      verdict = "BLOCKED";
      detail = e.message;
    } else {
      verdict = "ERROR";
      detail = String(e);
    }
  } finally {
    await closeObs(launch.pid).catch(() => {});
    await restoreUserState(snapshot).catch(() => {});
  }

  console.log(`VERDICT: ${verdict} — ${detail}`);
  if (verdict !== "HIDDEN") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("verify-hidden-launch crashed:", e);
  process.exitCode = 1;
});
