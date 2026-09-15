import { useCallback, useEffect, useRef, useState } from "react";
import { RealObsClient, type ObsClient } from "../obs/client.js";
import {
  ClipPlayer,
  clipsDirFileUrl,
  scanClipsFolder,
  validateClip,
  type ClipsDirIo,
} from "../clips/index.js";
import {
  applySavedMeta,
  CLIP_VOLUME_STEPS,
  CLIPS_COPY,
  clipsReducer,
  initialClipsState,
  loadClipsPersist,
  persistClips,
  type Clip,
  type ClipsAction,
  type ClipsState,
} from "../state/clips.js";
import { useAppStore } from "../state/store.js";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function filePathOf(file: File): string {
  const api = typeof window === "undefined" ? undefined : window.whatnotStudio;
  if (api?.pathForFile) {
    try {
      const fromBridge = api.pathForFile(file);
      if (typeof fromBridge === "string" && fromBridge !== "") return fromBridge;
    } catch {
      // fall through
    }
  }
  const withPath = file as File & { path?: string };
  return typeof withPath.path === "string" && withPath.path !== "" ? withPath.path : file.name;
}

function looksLikeAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

export default function ClipsPanel(props: { client?: ObsClient } = {}) {
  const obsPort = useAppStore((s) => s.showConfig.obsPort);
  const obsPassword = useAppStore((s) => s.showConfig.obsPassword);
  const connectionStatus = useAppStore((s) => s.connectionStatus);

  const [state, setState] = useState<ClipsState>(() => {
    const persisted = loadClipsPersist(browserStorage());
    const clips = applySavedMeta(
      persisted.metas.map((m) =>
        validateClip({
          fileName: m.filePath.split(/[\\/]/).pop() ?? m.filePath,
          filePath: m.filePath,
        })
      ),
      persisted.metas
    );
    return { ...initialClipsState(), muted: persisted.muted, clips };
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback((action: ClipsAction) => {
    setState((prev) => {
      const next = clipsReducer(prev, action);
      persistClips(next, browserStorage());
      return next;
    });
  }, []);

  const playerRef = useRef<ClipPlayer | null>(null);
  const clientRef = useRef<ObsClient | null>(props.client ?? null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ownClientRef = useRef<RealObsClient | null>(null);

  useEffect(() => {
    const given = props.client;
    let created: RealObsClient | null = null;
    if (given) {
      clientRef.current = given;
    } else {
      created = new RealObsClient();
      ownClientRef.current = created;
      clientRef.current = created;
      void created.connect(`ws://127.0.0.1:${obsPort}`, obsPassword).catch(() => {
        // buttons still render; press reports the disconnect
      });
    }

    const player = new ClipPlayer({
      getClient: () => clientRef.current,
      isConnected: () => {
        if (props.client) return useAppStore.getState().connectionStatus === "connected";
        return clientRef.current !== null;
      },
      fileExists: async (filePath) => {
        try {
          const api = window.whatnotStudio;
          if (!api?.clipsExists) return true;
          return await api.clipsExists(filePath);
        } catch {
          return false;
        }
      },
      onEnded: () => dispatch({ type: "PLAYBACK_ENDED" }),
      onError: (message) => dispatch({ type: "ERROR", message }),
    });
    playerRef.current = player;
    player.attach();

    return () => {
      player.dispose();
      playerRef.current = null;
      if (created) {
        void created.disconnect();
        ownClientRef.current = null;
      }
    };
  }, [obsPort, obsPassword, props.client, dispatch]);

  useEffect(() => {
    playerRef.current?.attach();
  }, [connectionStatus]);

  const refreshFromFolder = useCallback(async () => {
    const api = typeof window === "undefined" ? undefined : window.whatnotStudio;
    if (!api?.clipsDir || !api.clipsReaddir || !api.clipsExists) return;
    try {
      const dir = await api.clipsDir();
      const io: ClipsDirIo = {
        readdir: (folder) => api.clipsReaddir(folder),
        exists: (filePath) => api.clipsExists(filePath),
        mkdir: api.clipsMkdir ? (folder) => api.clipsMkdir(folder) : undefined,
        durationMs: api.clipsDurationMs ? (filePath) => api.clipsDurationMs(filePath) : undefined,
      };
      const scanned = await scanClipsFolder(dir, io);
      const metas = stateRef.current.clips.map((c) => ({
        filePath: c.filePath,
        label: c.label,
        volumeStep: c.volumeStep,
      }));
      dispatch({ type: "SET_CLIPS", clips: applySavedMeta(scanned, metas) });
    } catch {
      // keep the last list; buttons must stay usable
    }
  }, [dispatch]);

  useEffect(() => {
    void refreshFromFolder();
    const onFocus = () => {
      void refreshFromFolder();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFromFolder]);

  async function ingestFiles(files: FileList | File[]) {
    const list = [...files];
    if (list.length === 0) return;
    const api = typeof window === "undefined" ? undefined : window.whatnotStudio;
    if (api?.clipsImport || api?.clipsWrite) {
      for (const file of list) {
        const src = filePathOf(file);
        let copied: string | null = null;
        try {
          if (api.clipsImport && looksLikeAbsolutePath(src)) {
            copied = await api.clipsImport(src);
          }
          if (!copied && api.clipsWrite) {
            const bytes = await file.arrayBuffer();
            copied = await api.clipsWrite(file.name, bytes);
          }
        } catch {
          copied = null;
        }
        if (!copied) {
          dispatch({ type: "ERROR", message: CLIPS_COPY.dropHint });
        }
      }
      await refreshFromFolder();
      return;
    }

    const incoming = list.map((file) => validateClip({ fileName: file.name, filePath: filePathOf(file) }));
    const existing = new Map(stateRef.current.clips.map((c) => [c.filePath, c]));
    for (const clip of incoming) {
      const prev = existing.get(clip.filePath);
      existing.set(clip.filePath, prev ? { ...clip, label: prev.label, volumeStep: prev.volumeStep } : clip);
    }
    dispatch({ type: "SET_CLIPS", clips: [...existing.values()] });
  }

  function press(clip: Clip) {
    if (stateRef.current.playingId === clip.id) {
      stopPlaying();
      return;
    }
    dispatch({ type: "PLAY", id: clip.id });
    if (!clip.usable) return;
    playerRef.current?.play(clip, stateRef.current.muted, clip.volumeStep);
  }

  function stopPlaying() {
    playerRef.current?.hide();
  }

  async function openFolder() {
    const api = window.whatnotStudio;
    try {
      if (!api?.clipsDir) {
        dispatch({ type: "ERROR", message: CLIPS_COPY.dropHint });
        return;
      }
      const dir = await api.clipsDir();
      if (!dir) {
        dispatch({ type: "ERROR", message: CLIPS_COPY.dropHint });
        return;
      }
      await api.openExternal(clipsDirFileUrl(dir));
    } catch {
      dispatch({ type: "ERROR", message: CLIPS_COPY.dropHint });
    }
  }

  const studioDown = connectionStatus !== "connected" && !props.client;

  return (
    <section
      className="flex flex-col gap-3 rounded-md bg-neutral-900 p-3 ring-1 ring-neutral-800"
      aria-label={CLIPS_COPY.title}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void ingestFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{CLIPS_COPY.title}</h2>
        {state.playingId ? (
          <span className="text-sm font-semibold uppercase tracking-wide text-amber-300">Playing</span>
        ) : null}
      </div>

      {studioDown ? (
        <p className="rounded-md bg-amber-950 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-800">
          {CLIPS_COPY.disconnected}
        </p>
      ) : null}

      {state.error ? (
        <p className="rounded-md bg-amber-950 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-800">
          {state.error}
        </p>
      ) : null}

      <button
        className="h-16 w-full rounded-md bg-neutral-800 text-base font-semibold hover:bg-neutral-700"
        onClick={() => void openFolder()}
      >
        {CLIPS_COPY.openFolder}
      </button>

      <label className="flex items-center gap-3 rounded-md bg-neutral-950 px-3 py-3 text-base">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={state.muted}
          onChange={(e) => {
            const muted = e.target.checked;
            dispatch({ type: "SET_MUTED", muted });
            const playing = stateRef.current.clips.find((c) => c.id === stateRef.current.playingId);
            playerRef.current?.setMuted(muted, playing?.volumeStep ?? "normal");
          }}
        />
        <span>{CLIPS_COPY.silentTonight}</span>
      </label>

      {state.playingId ? (
        <button
          className="h-16 w-full rounded-md bg-amber-500 text-lg font-semibold text-neutral-950 hover:bg-amber-400"
          onClick={() => stopPlaying()}
        >
          {CLIPS_COPY.stop}
        </button>
      ) : null}

      {state.clips.length === 0 ? (
        <p className="text-sm text-neutral-400">{CLIPS_COPY.empty}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {state.clips.map((clip, index) => (
            <div
              key={clip.id}
              className={`flex flex-col gap-2 rounded-md p-2 ring-1 ${
                clip.usable ? "bg-neutral-950 ring-neutral-800" : "bg-neutral-950 ring-amber-900"
              }`}
            >
              <div className="flex gap-2">
                <button
                  className={`min-h-16 flex-1 rounded-md px-3 text-left text-xl font-semibold ${
                    !clip.usable
                      ? "bg-neutral-800 text-neutral-500"
                      : state.playingId === clip.id
                        ? "bg-amber-500 text-neutral-950"
                        : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
                  }`}
                  onClick={() => press(clip)}
                >
                  {clip.label}
                </button>
                <div className="flex flex-col gap-1">
                  <button
                    className="h-8 w-10 rounded-md bg-neutral-800 text-sm hover:bg-neutral-700 disabled:opacity-30"
                    disabled={index === 0}
                    aria-label={CLIPS_COPY.moveUp}
                    onClick={() => dispatch({ type: "MOVE", id: clip.id, direction: "up" })}
                  >
                    ↑
                  </button>
                  <button
                    className="h-8 w-10 rounded-md bg-neutral-800 text-sm hover:bg-neutral-700 disabled:opacity-30"
                    disabled={index === state.clips.length - 1}
                    aria-label={CLIPS_COPY.moveDown}
                    onClick={() => dispatch({ type: "MOVE", id: clip.id, direction: "down" })}
                  >
                    ↓
                  </button>
                </div>
              </div>
              <input
                className="rounded-md bg-neutral-900 px-3 py-2 text-sm outline-none ring-1 ring-neutral-800 focus:ring-neutral-500"
                value={clip.label}
                aria-label="Clip label"
                onChange={(e) => dispatch({ type: "SET_LABEL", id: clip.id, label: e.target.value })}
              />
              {clip.usable ? (
                <div className="flex gap-2">
                  {CLIP_VOLUME_STEPS.map((step) => (
                    <button
                      key={step.id}
                      className={`h-12 flex-1 rounded-md text-sm font-semibold ${
                        clip.volumeStep === step.id
                          ? "bg-amber-500 text-neutral-950"
                          : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
                      }`}
                      onClick={() => dispatch({ type: "SET_VOLUME", id: clip.id, step: step.id })}
                    >
                      {step.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-amber-200">{clip.reason}</p>
              )}
              {clip.longWarning ? <p className="text-sm text-amber-200">{clip.longWarning}</p> : null}
            </div>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.webm,.gif,video/mp4,video/webm,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void ingestFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        className="h-16 w-full rounded-md bg-neutral-800 text-base font-semibold hover:bg-neutral-700"
        onClick={() => fileInputRef.current?.click()}
      >
        {CLIPS_COPY.addClips}
      </button>
      <p className="text-xs text-neutral-500">{CLIPS_COPY.dropHint}</p>
    </section>
  );
}
