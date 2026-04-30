import { describe, expect, it } from "vitest";
import { injectGatewayAuth } from "../src/launcher/gateway-bridge";

describe("gateway bridge", () => {
  it("injects gateway token into connect frames without exposing it elsewhere", () => {
    const outbound = injectGatewayAuth(
      JSON.stringify({
        type: "req",
        id: "1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "webchat-ui", mode: "webchat", version: "0.1.0" },
          scopes: ["operator.read"]
        }
      }),
      { token: "secret-token" }
    );

    expect(JSON.parse(outbound)).toMatchObject({
      type: "req",
      method: "connect",
      params: {
        auth: { token: "secret-token" },
        client: { id: "gateway-client", mode: "backend", displayName: "We-Claw Bridge" }
      }
    });
  });

  it("leaves non-connect frames unchanged", () => {
    const frame = JSON.stringify({ type: "req", id: "2", method: "health", params: {} });
    expect(injectGatewayAuth(frame, { token: "secret-token" })).toBe(frame);
  });
});
