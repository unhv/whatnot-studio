/** Shared types used by the OBS logic, the Zustand store and the renderer. */

export const SCENE_KEYS = ["ME", "TABLE", "BOTH", "BREAK"] as const;
export type SceneKey = (typeof SCENE_KEYS)[number];

/** A device chosen on the Setup screen. `deviceId` is the OBS input's
 * device_id/value as reported by the source's properties list — kept
 * opaque here, since we never need to interpret it, only pass it through
 * to `SetInputSettings`. */
export interface DeviceChoice {
  deviceId: string;
  label: string;
}

/** Seller's quality choice. Automatic re-tests at go-live; Best/Steady are pinned. */
export type QualityChoice = "automatic" | "best" | "steady";

export interface ShowConfig {
  showName: string;
  camera: DeviceChoice | null;
  mic: DeviceChoice | null;
  /** Optional capture card, used as the TABLE source. If absent, TABLE
   * falls back to the same camera as ME (single-camera sellers). */
  captureCard: DeviceChoice | null;
  obsPassword: string;
  obsPort: number;
  /** Default automatic. Re-tested at go-live rather than blindly reused. */
  qualityChoice?: QualityChoice;
  /** Opt-in graphics-card encoder. Off by default; never auto-detected. */
  hardwareEncoder?: boolean;
  /** True after we write a hardware encoder, until Go Live confirms or we revert. */
  hardwareEncoderPending?: boolean;
  previousSimpleEncoder?: string | null;
  previousAdvEncoder?: string | null;
  /** One line of what Automatic found, in words. */
  lastQualitySummary?: string | null;
}

export const PROFILE_NAME = "Whatnot Studio";
export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1920;

/** Assumed source aspect ratio for crop-to-fill maths when the real
 * resolution of a chosen device is not yet known (see FINDINGS.md and
 * HANDOVER.md — nearly every webcam/capture card is 16:9). */
export const ASSUMED_SOURCE_WIDTH = 1920;
export const ASSUMED_SOURCE_HEIGHT = 1080;
