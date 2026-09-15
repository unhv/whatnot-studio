/**
 * ObsClient used by the audio panel. Separate from RealObsClient so we
 * can reidentify for InputVolumeMeters without editing src/obs/client.ts.
 */
import type { ObsClient } from "../obs/client.js";
import { EVENT_SUBSCRIPTION_ALL } from "./constants.js";

type Socket = {
  connect: (url: string, password?: string, opts?: { eventSubscriptions?: number }) => Promise<unknown>;
  disconnect: () => Promise<void>;
  call: (requestType: string, requestData?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, listener: (data: unknown) => void) => void;
  off: (event: string, listener: (data: unknown) => void) => void;
  reidentify: (data: { eventSubscriptions: number }) => Promise<unknown>;
};

export class AudioObsClient implements ObsClient {
  private socket: Socket | null = null;

  private async ensureSocket(): Promise<Socket> {
    if (!this.socket) {
      const { default: OBSWebSocket } = await import("obs-websocket-js");
      this.socket = new OBSWebSocket() as unknown as Socket;
    }
    return this.socket;
  }

  async connect(url: string, password?: string): Promise<void> {
    const socket = await this.ensureSocket();
    await socket.connect(url, password, { eventSubscriptions: EVENT_SUBSCRIPTION_ALL });
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

  async reidentify(data: { eventSubscriptions: number }): Promise<void> {
    if (!this.socket) return;
    await this.socket.reidentify(data);
  }
}
