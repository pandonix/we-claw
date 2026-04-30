import { describe, expect, it, vi } from "vitest";
import { capabilitiesFromHello, GatewayClient, parseGatewayFrame } from "../src/gateway/client";

class MockSocket extends EventTarget {
  static instance?: MockSocket;
  readyState = 0;
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    MockSocket.instance = this;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

describe("GatewayClient", () => {
  it("parses valid frames and rejects malformed frames", () => {
    expect(parseGatewayFrame('{"type":"res","id":"1","result":{"ok":true}}')).toEqual({
      type: "res",
      id: "1",
      result: { ok: true }
    });
    expect(() => parseGatewayFrame("{}")).toThrow("missing type");
  });

  it("extracts method capabilities from hello payloads", () => {
    const capabilities = capabilitiesFromHello({ features: { methods: ["health", "sessions.list", 42] } });
    expect(capabilities.methods.has("health")).toBe(true);
    expect(capabilities.methods.has("sessions.list")).toBe(true);
    expect(capabilities.methods.has("42")).toBe(false);
  });

  it("maps request ids to matching responses", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient("ws://127.0.0.1:18789", MockSocket as unknown as typeof WebSocket);
    const connected = client.connect();
    MockSocket.instance?.open();
    MockSocket.instance?.message({ type: "event", event: "connect.challenge", payload: { nonce: "abc" } });
    expect(JSON.parse(MockSocket.instance?.sent[0] ?? "{}")).toMatchObject({
      type: "req",
      id: "1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "gateway-client", mode: "backend" }
      }
    });
    MockSocket.instance?.message({ type: "res", id: "1", ok: true, payload: { methods: ["health"] } });
    await connected;

    const request = client.request("health");
    expect(JSON.parse(MockSocket.instance?.sent[1] ?? "{}")).toMatchObject({ type: "req", id: "2", method: "health" });
    MockSocket.instance?.message({ type: "res", id: "2", ok: true, payload: { ready: true } });
    await expect(request).resolves.toEqual({ ready: true });
    vi.useRealTimers();
  });
});
