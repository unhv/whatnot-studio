import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (data: unknown) => void;

const harness = vi.hoisted(() => {
  const sockets: MockSocket[] = [];
  let failConstruct = false;

  class MockSocket {
    readonly listeners = new Map<string, Set<Listener>>();
    readonly connectCalls: { url: string; password?: string }[] = [];
    disconnectCalls = 0;

    on(event: string, listener: Listener) {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener);
    }

    off(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener);
    }

    async connect(url: string, password?: string) {
      this.connectCalls.push({ url, password });
    }

    async disconnect() {
      this.disconnectCalls += 1;
    }

    async call() {
      return {};
    }
  }

  return {
    sockets,
    MockSocket,
    get failConstruct() {
      return failConstruct;
    },
    setFailConstruct(value: boolean) {
      failConstruct = value;
    },
    reset() {
      sockets.length = 0;
      failConstruct = false;
    },
  };
});

type MockSocket = InstanceType<typeof harness.MockSocket>;

vi.mock("obs-websocket-js", () => ({
  default: class {
    constructor() {
      if (harness.failConstruct) {
        throw new Error("obs websocket construct failed");
      }
      const socket = new harness.MockSocket();
      harness.sockets.push(socket);
      return socket;
    }
  },
}));

import { RealObsClient } from "../src/obs/client.js";

const URL = "ws://127.0.0.1:4455";
const PASSWORD = "pw";

describe("RealObsClient socket construction", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("gives concurrent on() and connect() the same socket, with the listener on it", async () => {
    const client = new RealObsClient();
    const listener = () => {};
    client.on("ConnectionClosed", listener);
    await client.connect(URL, PASSWORD);

    const connected = harness.sockets.filter((s) => s.connectCalls.length > 0);
    expect(connected).toHaveLength(1);
    expect(harness.sockets).toHaveLength(1);
    expect(connected[0].listeners.get("ConnectionClosed")?.has(listener)).toBe(true);
    expect(connected[0].connectCalls).toEqual([{ url: URL, password: PASSWORD }]);
  });

  it("builds a new socket after disconnect rather than reusing the old one", async () => {
    const client = new RealObsClient();
    await client.connect(URL, PASSWORD);
    expect(harness.sockets).toHaveLength(1);
    const first = harness.sockets[0];

    await client.disconnect();
    expect(first.disconnectCalls).toBe(1);

    await client.connect(URL, PASSWORD);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[1]).not.toBe(first);
    expect(harness.sockets[1].connectCalls).toEqual([{ url: URL, password: PASSWORD }]);
  });

  it("retries construction after a failed import rather than caching the rejection", async () => {
    harness.setFailConstruct(true);
    const client = new RealObsClient();
    await expect(client.connect(URL, PASSWORD)).rejects.toThrow(/construct failed/);
    expect(harness.sockets).toHaveLength(0);

    harness.setFailConstruct(false);
    await client.connect(URL, PASSWORD);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0].connectCalls).toEqual([{ url: URL, password: PASSWORD }]);
  });

  it("detaches via off() even when construction is still pending", async () => {
    const client = new RealObsClient();
    const listener = () => {};
    client.on("ConnectionClosed", listener);
    client.off("ConnectionClosed", listener);
    await client.connect(URL, PASSWORD);

    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0].listeners.get("ConnectionClosed")?.has(listener)).toBe(false);
  });
});
