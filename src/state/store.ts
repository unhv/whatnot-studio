/**
 * The one Zustand store for the whole app (brief: "one window, one store,
 * no router"). UI/session state only — the pure logic it calls into
 * (itemBarReducer, buildDesiredScenes, deriveLiveState, ...) lives in
 * src/obs and src/state/itemBar.ts and is unit-tested independently of
 * this store.
 */
import { create } from "zustand";
import { SCENE_KEYS, type SceneKey, type ShowConfig } from "../shared/types.js";
import { initialItemBarState, itemBarReducer, type ItemBarAction, type ItemBarState } from "./itemBar.js";
import { initialLiveState, type LiveState } from "../obs/liveMode.js";

export type Screen = "setup" | "live";

export interface AppState {
  screen: Screen;
  showConfig: ShowConfig;
  activeScene: SceneKey;
  micMuted: boolean;
  itemBar: ItemBarState;
  live: LiveState;
  connectionStatus: "disconnected" | "connecting" | "connected" | "error";

  setShowConfig(config: Partial<ShowConfig>): void;
  goToLive(): void;
  goToSetup(): void;
  setActiveScene(scene: SceneKey): void;
  setMicMuted(muted: boolean): void;
  dispatchItemBar(action: ItemBarAction): void;
  setLive(live: LiveState): void;
  setConnectionStatus(status: AppState["connectionStatus"]): void;
}

export const DEFAULT_SHOW_CONFIG: ShowConfig = {
  showName: "",
  camera: null,
  mic: null,
  captureCard: null,
  obsPassword: "",
  obsPort: 4455,
};

export const useAppStore = create<AppState>((set) => ({
  screen: "setup",
  showConfig: DEFAULT_SHOW_CONFIG,
  activeScene: SCENE_KEYS[0],
  micMuted: false,
  itemBar: initialItemBarState(),
  live: initialLiveState(Date.now()),
  connectionStatus: "disconnected",

  setShowConfig: (config) => set((s) => ({ showConfig: { ...s.showConfig, ...config } })),
  goToLive: () => set({ screen: "live" }),
  goToSetup: () =>
    set((s) => (s.live.live ? s : { screen: "setup" })), // "Setup" link is disabled while LIVE
  setActiveScene: (scene) => set({ activeScene: scene }),
  setMicMuted: (muted) => set({ micMuted: muted }),
  dispatchItemBar: (action) => set((s) => ({ itemBar: itemBarReducer(s.itemBar, action) })),
  setLive: (live) => set({ live }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
}));
