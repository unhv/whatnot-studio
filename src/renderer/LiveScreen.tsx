import { useEffect, useRef, useState } from "react";
import { ItemBarObsSync, setItemBarObsSync, useAppStore } from "../state/store.js";
import { elapsedMs, liveScreenCopy } from "../obs/liveMode.js";
import { RealObsClient } from "../obs/client.js";
import { formatElapsed, formatPrice } from "../shared/format.js";
import { deriveLowerThirdText } from "../state/itemBar.js";
import { SCENE_KEYS, type SceneKey } from "../shared/types.js";
import {
  canReturnToSetup,
  returnToSetup,
  startLiveScreenSession,
} from "./liveScreenSession.js";
import AudioPanel from "./AudioPanel.js";

const SCENE_HOTKEYS: Record<SceneKey, string> = { ME: "F1", TABLE: "F2", BOTH: "F3", BREAK: "F4" };

/** The product. ~520px wide, full height, dark, nothing under 16px, no
 * button under 64px — sized to sit beside the seller's browser. */
export default function LiveScreen() {
  const live = useAppStore((s) => s.live);
  const activeScene = useAppStore((s) => s.activeScene);
  const setActiveScene = useAppStore((s) => s.setActiveScene);
  const itemBar = useAppStore((s) => s.itemBar);
  const dispatchItemBar = useAppStore((s) => s.dispatchItemBar);
  const obsPort = useAppStore((s) => s.showConfig.obsPort);
  const obsPassword = useAppStore((s) => s.showConfig.obsPassword);

  const [now, setNow] = useState(() => Date.now());
  const retryNowRef = useRef<() => void>(() => {});

  // First-run's ObsClient is discarded after setup; this session is what
  // applies the four-scene plan (Item Bar / SOLD Banner) on first connect,
  // then folds StreamStateChanged / ConnectionClosed into the store.
  useEffect(() => {
    const client = new RealObsClient();
    const sync = new ItemBarObsSync({
      getClient: () => client,
      isConnected: () => useAppStore.getState().connectionStatus === "connected",
    });
    setItemBarObsSync(sync);
    const unsub = useAppStore.subscribe((state, prev) => {
      if (prev.connectionStatus !== "connected" && state.connectionStatus === "connected") {
        sync.resync(state.itemBar);
      }
    });
    const session = startLiveScreenSession({
      client,
      url: `ws://127.0.0.1:${obsPort}`,
      password: obsPassword,
    });
    retryNowRef.current = () => session.retryNow();
    return () => {
      retryNowRef.current = () => {};
      unsub();
      setItemBarObsSync(null);
      sync.dispose();
      session.stop();
    };
  }, [obsPort, obsPassword]);

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      dispatchItemBar({ type: "TICK", now: t });
    }, 250);
    return () => clearInterval(id);
  }, [dispatchItemBar]);

  const [itemDraft, setItemDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const lowerThird = deriveLowerThirdText(itemBar);
  const selling = itemBar.soldUntil !== null;
  const status = liveScreenCopy(live);
  const statusDotClass = live.live
    ? "text-red-500"
    : live.connecting
      ? "text-amber-400"
      : "text-neutral-500";

  function showItem() {
    if (itemDraft.trim() === "") return;
    dispatchItemBar({ type: "SET_ITEM", item: itemDraft, price: formatPrice(priceDraft) });
    dispatchItemBar({ type: "SHOW" });
  }

  function clearItem() {
    dispatchItemBar({ type: "CLEAR" });
    setItemDraft("");
    setPriceDraft("");
  }

  function sold() {
    dispatchItemBar({ type: "SOLD", now: Date.now() });
  }

  return (
    <div className="flex min-h-screen w-[520px] flex-col gap-4 bg-neutral-950 p-4 text-neutral-100">
      {/* Status strip. No Go Live button, ever — this only ever reflects
          StreamStateChanged from Whatnot's own Show Tools page. */}
      <div className="flex items-center justify-between rounded-md bg-neutral-900 px-4 py-3">
        <div className="flex items-start gap-2">
          <span className={`${statusDotClass} mt-1 text-lg leading-none`}>●</span>
          <div>
            <div className="text-lg font-semibold">
              {status.primary}
              {status.showElapsed ? ` ${formatElapsed(elapsedMs(live, now))}` : ""}
            </div>
            {status.secondary ? (
              <div className="text-sm font-normal text-amber-200/80">{status.secondary}</div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {live.socketDisconnected ? (
            <button
              className="rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-700"
              onClick={() => retryNowRef.current()}
            >
              Reconnect
            </button>
          ) : null}
          <button
            className="text-sm text-neutral-400 underline disabled:cursor-not-allowed disabled:text-neutral-700 disabled:no-underline"
            disabled={!canReturnToSetup(live)}
            onClick={returnToSetup}
          >
            Setup
          </button>
        </div>
      </div>

      {/* Preview, ~270px wide portrait, not clickable. Populated by polling
          GetSourceScreenshot at 2-4fps once connected — see HANDOVER.md. */}
      <div className="mx-auto flex h-[480px] w-[270px] items-center justify-center rounded-md bg-black ring-1 ring-neutral-800">
        <span className="text-xs text-neutral-600">Preview</span>
      </div>

      {/* Scene grid: straight cut between ME/TABLE/BOTH, 300ms fade into/out
          of BREAK — the fade duration itself is applied over the websocket,
          not here; this button only sets the intent. */}
      <div className="grid grid-cols-2 gap-3">
        {SCENE_KEYS.map((key) => (
          <button
            key={key}
            className={`h-24 rounded-md text-xl font-semibold transition-colors ${
              activeScene === key ? "bg-amber-500 text-neutral-950" : "bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
            }`}
            onClick={() => setActiveScene(key)}
          >
            <div>{key}</div>
            <div className="text-xs font-normal opacity-70">{SCENE_HOTKEYS[key]}</div>
          </button>
        ))}
      </div>

      {/* Item bar */}
      <div className="flex flex-col gap-2 rounded-md bg-neutral-900 p-3">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md bg-neutral-950 px-3 py-3 text-base outline-none ring-1 ring-neutral-800 focus:ring-neutral-500"
            placeholder="What's on the table"
            value={itemDraft}
            onChange={(e) => {
              const value = e.target.value;
              setItemDraft(value);
              dispatchItemBar({ type: "SET_ITEM", item: value, price: formatPrice(priceDraft) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") showItem();
            }}
          />
          <input
            className="w-24 rounded-md bg-neutral-950 px-3 py-3 text-base outline-none ring-1 ring-neutral-800 focus:ring-neutral-500"
            placeholder="Price"
            value={priceDraft}
            onChange={(e) => {
              const value = e.target.value;
              setPriceDraft(value);
              dispatchItemBar({ type: "SET_ITEM", item: itemDraft, price: formatPrice(value) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") showItem();
            }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-400">{lowerThird ?? "Nothing on canvas"}</span>
          <button className="rounded-md bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700" onClick={clearItem}>
            CLEAR
          </button>
        </div>
      </div>

      {/* SOLD — the biggest button on the screen. */}
      <button
        className="h-20 w-full rounded-md bg-amber-400 text-3xl font-bold text-neutral-950 hover:bg-amber-300"
        onClick={sold}
      >
        {selling ? "SOLD!" : "SOLD! (F5)"}
      </button>

      <AudioPanel />
    </div>
  );
}
