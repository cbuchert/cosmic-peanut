import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "./connection.js";

class FakeSocket {
  /** @type {FakeSocket[]} */
  static all = [];
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.binaryType = "blob";
    /** @type {string[]} */
    this.sent = [];
    this.readyState = 0;
    /** @type {((ev: any) => void) | null} */ this.onopen = null;
    /** @type {((ev: any) => void) | null} */ this.onclose = null;
    /** @type {((ev: any) => void) | null} */ this.onmessage = null;
    /** @type {((ev: any) => void) | null} */ this.onerror = null;
    FakeSocket.all.push(this);
  }
  /** @param {string} s */
  send(s) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** @param {unknown} data */
  receive(data) {
    this.onmessage?.({ data });
  }
}

const config = { token: "tok en", pluginOrigin: "http://127.0.0.1:9", dev: false };

function setup() {
  FakeSocket.all = [];
  const fetch = vi.fn(async (/** @type {string} */ _url) => ({ ok: true, json: async () => config }));
  const onMessage = vi.fn();
  const onFrame = vi.fn();
  const onConfig = vi.fn();
  const onState = vi.fn();
  let t = 1000;
  const conn = createConnection({
    location: { search: "?token=tok%20en", host: "127.0.0.1:5000" },
    fetch,
    WebSocket: /** @type {any} */ (FakeSocket),
    now: () => t++,
    onMessage,
    onFrame,
    onConfig,
    onState,
  });
  return { conn, fetch, onMessage, onFrame, onConfig, onState };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("connection", () => {
  it("fetches config with the page token, then opens the websocket with arraybuffers", async () => {
    const { conn, fetch, onConfig } = setup();
    await conn.start();
    expect(fetch).toHaveBeenCalledWith("/config.json?token=tok%20en");
    expect(onConfig).toHaveBeenCalledWith(config);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].url).toBe("ws://127.0.0.1:5000/ws?token=tok%20en");
    expect(FakeSocket.all[0].binaryType).toBe("arraybuffer");
  });

  it("sends a heartbeat every 500 ms while open, and stops when closed", async () => {
    const { conn } = setup();
    await conn.start();
    const ws = FakeSocket.all[0];
    vi.advanceTimersByTime(600);
    expect(ws.sent).toHaveLength(0);
    ws.open();
    vi.advanceTimersByTime(1000);
    expect(ws.sent.map((s) => JSON.parse(s).type)).toEqual(["heartbeat", "heartbeat"]);
    expect(typeof JSON.parse(ws.sent[0]).t).toBe("number");
    ws.close();
    vi.advanceTimersByTime(1000);
    expect(ws.sent).toHaveLength(2);
  });

  it("routes validated JSON to onMessage, ignores unknown, and binary to onFrame", async () => {
    const { conn, onMessage, onFrame } = setup();
    await conn.start();
    const ws = FakeSocket.all[0];
    ws.open();
    ws.receive('{"type":"reload","key":"a/b"}');
    ws.receive('{"type":"mystery"}');
    ws.receive("not json");
    const buf = new ArrayBuffer(8);
    ws.receive(buf);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "reload", key: "a/b" });
    expect(onFrame).toHaveBeenCalledWith(buf);
  });

  it("reconnects with growing backoff and resets it after a successful open", async () => {
    const { conn, onState } = setup();
    await conn.start();
    FakeSocket.all[0].close();
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].close();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2].open();
    FakeSocket.all[2].close();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(4);
    expect(onState).toHaveBeenCalledWith("open");
    expect(onState).toHaveBeenCalledWith("closed");
  });

  it("send() writes JSON only while open; close() stops reconnecting", async () => {
    const { conn } = setup();
    await conn.start();
    const ws = FakeSocket.all[0];
    expect(conn.send({ type: "select", key: "a" })).toBe(false);
    ws.open();
    expect(conn.send({ type: "select", key: "a" })).toBe(true);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "select", key: "a" });
    conn.close();
    vi.advanceTimersByTime(10000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("retries the config fetch with backoff when it fails", async () => {
    FakeSocket.all = [];
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return { ok: true, json: async () => config };
    });
    const conn = createConnection({
      location: { search: "?token=x", host: "h:1" },
      fetch,
      WebSocket: /** @type {any} */ (FakeSocket),
      onMessage() {},
      onFrame() {},
    });
    await conn.start();
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
