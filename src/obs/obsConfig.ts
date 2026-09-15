/**
 * Parse OBS's own obs-websocket config.json. That file is the source of
 * truth for port, whether the server is on, and the password OBS will
 * accept — guessing any of those cannot work.
 *
 * Pure: no filesystem, no logging. The main process reads the file and
 * hands the text (or the OS error code) to `obsWebsocketConfigFromRead`.
 * Tests pass fixtures; they never touch the machine's real OBS config.
 */

export type ObsWebsocketConfigReason = "ok" | "missing-file" | "malformed" | "server-disabled";

export type ObsWebsocketConfig =
  | {
      reason: "ok";
      serverEnabled: true;
      serverPort: number;
      authRequired: boolean;
      serverPassword: string;
    }
  | { reason: "missing-file" }
  | { reason: "malformed" }
  | {
      reason: "server-disabled";
      serverEnabled: false;
      serverPort: number;
      authRequired: boolean;
      serverPassword: string;
    };

const DEFAULT_PORT = 4455;

function asPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (n > 0 && n < 65536) return n;
  }
  return null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function asPassword(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse the JSON body of obs-websocket's config.json. Never throws.
 * A disabled server is a typed reason, not an exception.
 */
export function parseObsWebsocketConfig(text: string): ObsWebsocketConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { reason: "malformed" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { reason: "malformed" };
  }
  const rec = json as Record<string, unknown>;
  const enabled = asBool(rec.server_enabled);
  if (enabled === null) return { reason: "malformed" };

  const serverPort = asPort(rec.server_port) ?? DEFAULT_PORT;
  const authRequired = asBool(rec.auth_required) ?? true;
  const serverPassword = asPassword(rec.server_password);

  if (!enabled) {
    return {
      reason: "server-disabled",
      serverEnabled: false,
      serverPort,
      authRequired,
      serverPassword,
    };
  }

  const explicitPort = asPort(rec.server_port);
  if (explicitPort === null) return { reason: "malformed" };

  return {
    reason: "ok",
    serverEnabled: true,
    serverPort: explicitPort,
    authRequired,
    serverPassword,
  };
}

export interface ObsConfigReadOk {
  ok: true;
  text: string;
}

export interface ObsConfigReadFail {
  ok: false;
  code?: string;
}

/** Map a file-read outcome onto a typed config result. Never throws. */
export function obsWebsocketConfigFromRead(read: ObsConfigReadOk | ObsConfigReadFail): ObsWebsocketConfig {
  if (!read.ok) {
    if (read.code === "ENOENT") return { reason: "missing-file" };
    return { reason: "malformed" };
  }
  return parseObsWebsocketConfig(read.text);
}

export function errorCodeFromUnknown(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
