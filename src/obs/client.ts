import type { ObsWebsocketConfig } from "./obsConfig.js";
import type { DeviceChoice } from "../shared/types.js";

/**
 * Thin injectable OBS client interface. Every other module in this app
 * (sceneCompiler, firstRun, liveMode) takes an `ObsClient`, never
 * `obs-websocket-js` directly — that is what makes them unit-testable
 * without ever launching OBS: tests pass a `FakeObsClient` (see
 * tests/testUtils/fakeObsClient.ts).
 *
 * OWNERSHIP RULE (do not undo this): after first-run setup, no code path
 * anywhere in this app may write the OBS stream *service* config (the
 * request that points OBS at an ingest endpoint) or otherwise write
 * output/stream settings, and the OBS CLI flag that forces the stream to
 * start on launch must never be passed. Whatnot's own Show Tools page
 * owns Go Live; this app only ever listens for `StreamStateChanged` (see
 * src/obs/liveMode.ts). `SetVideoSettings` is called from exactly one
 * place: src/obs/firstRun.ts, during first-run setup only.
 */

export interface ObsClient {
  connect(url: string, password?: string): Promise<void>;
  disconnect(): Promise<void>;
  call<T = unknown>(requestType: string, requestData?: Record<string, unknown>): Promise<T>;
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}

/** Why a websocket connection did not come up. Distinct from "no cameras". */
export type ObsConnectReason = "not-running" | "server-disabled" | "auth-failed" | "wrong-port";

export type ObsSetupAttempt =
  | { ok: true; port: number; video: DeviceChoice[]; audio: DeviceChoice[] }
  | { ok: false; reason: ObsConnectReason };

function errorCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * Map an obs-websocket-js (or TCP) failure onto a seller-facing reason.
 * Never includes the password in the result. Auth is not "OBS is not running".
 */
export function classifyObsConnectError(err: unknown): ObsConnectReason {
  const code = errorCode(err);
  const message = errorMessage(err);

  // obs-websocket WebSocketCloseCode: 4009 AuthenticationFailed.
  // 4008 is unused in some protocol versions; treat it as auth too if seen.
  if (code === 4009 || code === 4008) return "auth-failed";
  if (/\bauth/i.test(message)) return "auth-failed";

  // obs-websocket-js uses code -1 when something answered that is not
  // obs-websocket (wrong process on that port, or a stale port).
  if (code === -1) return "wrong-port";
  if (code === 1002 || code === 1003) return "wrong-port";
  if (/non-compatible|unsupported rpc|unexpected server|not identified/i.test(message)) {
    return "wrong-port";
  }

  return "not-running";
}

export function credentialsFromConfig(config: ObsWebsocketConfig): { port: number; password: string } | null {
  if (config.reason === "ok" || config.reason === "server-disabled") {
    return { port: config.serverPort, password: config.serverPassword };
  }
  return null;
}

export async function connectUsingObsConfig(
  client: ObsClient,
  config: ObsWebsocketConfig
): Promise<{ ok: true; port: number; password: string } | { ok: false; reason: ObsConnectReason }> {
  if (config.reason === "missing-file") return { ok: false, reason: "not-running" };
  if (config.reason === "malformed") return { ok: false, reason: "wrong-port" };
  if (config.reason === "server-disabled") return { ok: false, reason: "server-disabled" };

  const password = config.authRequired ? config.serverPassword : undefined;
  const url = `ws://127.0.0.1:${config.serverPort}`;
  try {
    await client.connect(url, password);
    return { ok: true, port: config.serverPort, password: config.serverPassword };
  } catch (err) {
    return { ok: false, reason: classifyObsConnectError(err) };
  }
}

export interface ObsSetupSessionOpts {
  client: ObsClient;
  loadConfig: () => Promise<ObsWebsocketConfig>;
  enumerate: (client: ObsClient) => Promise<{ video: DeviceChoice[]; audio: DeviceChoice[] }>;
  onAttempt: (attempt: ObsSetupAttempt) => void;
  /** Called whenever OBS's own config yielded a port/password, even if we did not connect. */
  onCredentials?: (creds: { port: number; password: string }) => void;
}

/**
 * Read OBS's websocket config, connect with what it actually expects, and
 * enumerate devices. `retry` always re-reads the config — it does not reuse
 * a previous parse.
 */
export function startObsSetupSession(opts: ObsSetupSessionOpts): { stop: () => void; retry: () => void } {
  const { client, loadConfig, enumerate, onAttempt, onCredentials } = opts;
  let cancelled = false;
  let inFlight = false;
  let generation = 0;

  const onClosed = () => {
    if (cancelled) return;
    onAttempt({ ok: false, reason: "not-running" });
  };

  async function connectAndEnumerate() {
    if (cancelled || inFlight) return;
    inFlight = true;
    const my = ++generation;
    client.off("ConnectionClosed", onClosed);
    try {
      try {
        await client.disconnect();
      } catch {
        // already closed
      }
      if (cancelled || my !== generation) return;

      const config = await loadConfig();
      if (cancelled || my !== generation) return;

      const creds = credentialsFromConfig(config);
      if (creds) onCredentials?.(creds);

      const connected = await connectUsingObsConfig(client, config);
      if (cancelled || my !== generation) {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
        return;
      }
      if (!connected.ok) {
        onAttempt({ ok: false, reason: connected.reason });
        return;
      }

      client.on("ConnectionClosed", onClosed);
      let devices = { video: [] as DeviceChoice[], audio: [] as DeviceChoice[] };
      try {
        devices = await enumerate(client);
      } catch {
        devices = { video: [], audio: [] };
      }
      if (cancelled || my !== generation) return;
      onAttempt({
        ok: true,
        port: connected.port,
        video: devices.video,
        audio: devices.audio,
      });
    } catch {
      if (cancelled || my !== generation) return;
      onAttempt({ ok: false, reason: "not-running" });
    } finally {
      inFlight = false;
    }
  }

  void connectAndEnumerate();

  return {
    stop: () => {
      cancelled = true;
      generation += 1;
      client.off("ConnectionClosed", onClosed);
      onAttempt({ ok: false, reason: "not-running" });
      void client.disconnect();
    },
    retry: () => {
      void connectAndEnumerate();
    },
  };
}

/** Real implementation, wrapping obs-websocket-js v5. Constructed lazily so
 * importing this module never touches a socket. */
export class RealObsClient implements ObsClient {
  // Typed loosely deliberately: obs-websocket-js's OBSWebSocket type is
  // imported dynamically so this module has zero side effects at import
  // time, which keeps it safe to import from tests that never call connect().
  private socket: {
    connect: (url: string, password?: string) => Promise<unknown>;
    disconnect: () => Promise<void>;
    call: (requestType: string, requestData?: Record<string, unknown>) => Promise<unknown>;
    on: (event: string, listener: (data: unknown) => void) => void;
    off: (event: string, listener: (data: unknown) => void) => void;
  } | null = null;

  private async ensureSocket() {
    if (!this.socket) {
      const { default: OBSWebSocket } = await import("obs-websocket-js");
      this.socket = new OBSWebSocket() as unknown as typeof this.socket;
    }
    return this.socket!;
  }

  async connect(url: string, password?: string): Promise<void> {
    const socket = await this.ensureSocket();
    await socket.connect(url, password);
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return;
    await this.socket.disconnect();
  }

  async call<T = unknown>(requestType: string, requestData?: Record<string, unknown>): Promise<T> {
    const socket = await this.ensureSocket();
    return (await socket.call(requestType, requestData)) as T;
  }

  on(event: string, listener: (data: unknown) => void): void {
    void this.ensureSocket().then((socket) => socket.on(event, listener));
  }

  off(event: string, listener: (data: unknown) => void): void {
    if (!this.socket) return;
    this.socket.off(event, listener);
  }
}
