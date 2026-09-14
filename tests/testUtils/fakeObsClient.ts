import type { ObsClient } from "../../src/obs/client.js";

/** A scriptable fake ObsClient for tests. Never touches a network or a
 * real OBS — `responses` maps requestType -> canned response (or a
 * function of the request data), and every call is recorded in `calls`. */
export class FakeObsClient implements ObsClient {
  calls: { requestType: string; requestData?: Record<string, unknown> }[] = [];
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(
    private responses: Record<string, unknown | ((data?: Record<string, unknown>) => unknown)> = {}
  ) {}

  async connect(): Promise<void> {
    this.connectCalls++;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
  }

  async call<T = unknown>(requestType: string, requestData?: Record<string, unknown>): Promise<T> {
    this.calls.push({ requestType, requestData });
    const entry = this.responses[requestType];
    if (typeof entry === "function") {
      return (entry as (data?: Record<string, unknown>) => unknown)(requestData) as T;
    }
    if (entry === undefined) {
      throw new Error(`FakeObsClient: no canned response for "${requestType}"`);
    }
    return entry as T;
  }

  on(): void {
    // no-op: nothing in this repo's tests needs event delivery from the fake
  }

  off(): void {
    // no-op
  }
}
