/**
 * Global mute shortcut — one state, two ways to change it.
 * Registration is injected so tests never load Electron.
 */
export const DEFAULT_MUTE_ACCELERATOR = "Control+Alt+M";

/** Exact seller-facing copy when Electron returns false from register. */
export const MUTE_HOTKEY_FAILED_COPY = "the shortcut could not be set up";

export const MIC_OFF_BANNER = "Your microphone is off";

export const MUTE_HOTKEY_STORAGE_KEY = "whatnot-studio-mute-hotkey";

export const MUTE_ACCELERATOR_CHOICES = [
  { accelerator: "Control+Alt+M", label: "Ctrl+Alt+M" },
  { accelerator: "Control+Shift+Period", label: "Ctrl+Shift+." },
  { accelerator: "F8", label: "F8" },
  { accelerator: "Control+Alt+Space", label: "Ctrl+Alt+Space" },
] as const;

const SCENE_HOTKEYS = new Set(["F1", "F2", "F3", "F4", "F5"]);

export type MuteHotkeyStatus = {
  accelerator: string;
  registered: boolean;
  message: string | null;
};

export type MuteSession = {
  getSnapshot: () => { settings: { micMuted: boolean } };
  setMuted: (muted: boolean) => Promise<void>;
};

export function isAllowedMuteAccelerator(value: string): boolean {
  if (SCENE_HOTKEYS.has(value)) return false;
  return MUTE_ACCELERATOR_CHOICES.some((choice) => choice.accelerator === value);
}

export function muteAcceleratorLabel(accelerator: string): string {
  const found = MUTE_ACCELERATOR_CHOICES.find((choice) => choice.accelerator === accelerator);
  return found?.label ?? accelerator;
}

export function muteHotkeyFromStored(raw: unknown, fallback = DEFAULT_MUTE_ACCELERATOR): string {
  if (typeof raw === "string" && isAllowedMuteAccelerator(raw)) return raw;
  if (raw !== null && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.accelerator === "string" && isAllowedMuteAccelerator(rec.accelerator)) {
      return rec.accelerator;
    }
  }
  return fallback;
}

export function liveMicrophoneBanner(muted: boolean): { text: string } | null {
  if (!muted) return null;
  return { text: MIC_OFF_BANNER };
}

/** Hotkey and on-screen button both call setMuted. No second source of truth. */
export async function applyMuteHotkeyToggle(session: MuteSession): Promise<void> {
  await session.setMuted(!session.getSnapshot().settings.micMuted);
}

export function createMuteHotkeyController(deps: {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  sendToggle: () => void;
}): {
  set(accelerator: string): MuteHotkeyStatus;
  get(): MuteHotkeyStatus;
  releaseAll(): void;
} {
  let current: string | null = null;
  let registered = false;

  function statusFor(accelerator: string, ok: boolean): MuteHotkeyStatus {
    return {
      accelerator,
      registered: ok,
      message: ok ? null : MUTE_HOTKEY_FAILED_COPY,
    };
  }

  return {
    set(accelerator: string) {
      const next = isAllowedMuteAccelerator(accelerator) ? accelerator : DEFAULT_MUTE_ACCELERATOR;
      if (current) {
        deps.unregister(current);
        current = null;
        registered = false;
      }
      const ok = deps.register(next, () => {
        deps.sendToggle();
      });
      current = next;
      registered = ok === true;
      return statusFor(next, registered);
    },
    get() {
      const accelerator = current ?? DEFAULT_MUTE_ACCELERATOR;
      if (current === null) return statusFor(accelerator, false);
      return statusFor(accelerator, registered);
    },
    releaseAll() {
      if (current) {
        deps.unregister(current);
      }
      current = null;
      registered = false;
    },
  };
}
