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
