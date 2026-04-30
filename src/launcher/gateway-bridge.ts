import crypto from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import type { LauncherContext } from "./bootstrap.js";
import { buildDeviceAuth, loadDeviceIdentity, type DeviceIdentity } from "./device-identity.js";
import { resolveGatewayAuth } from "./gateway-auth.js";

const BRIDGE_PATH = "/api/gateway/ws";

type UpgradeServer = {
  on(event: "upgrade", listener: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export function installGatewayBridge(server: UpgradeServer, context: LauncherContext): void {
  server.on("upgrade", (request, socket, head) => {
    const pathname = safePathname(request.url);
    if (pathname !== BRIDGE_PATH) return;
    void bridgeGatewayWebSocket(request, socket, head, context);
  });
}

export function gatewayBridgePath(): string {
  return BRIDGE_PATH;
}

export function injectGatewayAuth(frameText: string, options: { token?: string; identity?: DeviceIdentity; nonce?: string } = {}): string {
  const token = options.token;
  if (!token) return frameText;
  const frame = JSON.parse(frameText) as {
    type?: unknown;
    method?: unknown;
    params?: {
      auth?: Record<string, unknown>;
      client?: Record<string, unknown>;
    };
  };
  if (frame.type !== "req" || frame.method !== "connect" || !frame.params) return frameText;

  const client: Record<string, unknown> = {
    ...frame.params.client,
    id: "gateway-client",
    mode: "backend",
    platform: process.platform,
    displayName: "We-Claw Bridge"
  };
  const role = typeof (frame.params as { role?: unknown }).role === "string" ? (frame.params as { role: string }).role : "operator";
  const scopes = Array.isArray((frame.params as { scopes?: unknown }).scopes)
    ? ((frame.params as { scopes: unknown[] }).scopes.filter((scope): scope is string => typeof scope === "string"))
    : [];

  frame.params.auth = { ...frame.params.auth, token: frame.params.auth?.token ?? token };
  frame.params.client = client;
  if (options.identity && options.nonce) {
    (frame.params as { device?: unknown }).device = buildDeviceAuth({
      identity: options.identity,
      clientId: "gateway-client",
      clientMode: "backend",
      role,
      scopes,
      token,
      nonce: options.nonce,
      platform: typeof client.platform === "string" ? client.platform : undefined,
      deviceFamily: typeof client.deviceFamily === "string" ? client.deviceFamily : undefined
    });
  }
  return JSON.stringify(frame);
}

async function bridgeGatewayWebSocket(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: LauncherContext
): Promise<void> {
  if (request.socket.remoteAddress && !isLoopbackAddress(request.socket.remoteAddress)) {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const auth = await resolveGatewayAuth();
  const identity = await loadDeviceIdentity();
  if (auth.mode === "token" && !auth.token) {
    acceptBrowserSocket(socket, key);
    sendTextFrame(socket, JSON.stringify({ type: "event", event: "weclaw.bridge.error", payload: { message: "Gateway token auth is configured, but We-Claw could not resolve a token." } }));
    sendCloseFrame(socket, 1008, "gateway token missing");
    return;
  }

  const upstream = new WebSocket(`ws://${context.config.host}:${context.config.gatewayPort}`);
  const upstreamQueue: string[] = [];
  let connectNonce: string | undefined;

  acceptBrowserSocket(socket, key);

  upstream.addEventListener("open", () => {
    for (const item of upstreamQueue.splice(0)) upstream.send(item);
  });
  upstream.addEventListener("message", (event) => {
    const text = String(event.data ?? "");
    connectNonce = readConnectNonce(text) ?? connectNonce;
    sendTextFrame(socket, text);
  });
  upstream.addEventListener("close", (event) => {
    sendCloseFrame(socket, event.code || 1000, event.reason || "gateway closed");
  });
  upstream.addEventListener("error", () => {
    sendTextFrame(socket, JSON.stringify({ type: "event", event: "weclaw.bridge.error", payload: { message: "Gateway bridge failed to connect upstream." } }));
    sendCloseFrame(socket, 1011, "gateway bridge upstream error");
  });

  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = readClientFrame(buffer);
      if (!parsed) break;
      buffer = buffer.subarray(parsed.consumed);
      if (parsed.opcode === 8) {
        upstream.close();
        socket.end();
        return;
      }
      if (parsed.opcode === 9) {
        sendControlFrame(socket, 10, parsed.payload);
        continue;
      }
      if (parsed.opcode !== 1) continue;
      const text = parsed.payload.toString("utf8");
      let outbound = text;
      try {
        outbound = injectGatewayAuth(text, { token: auth.token, identity, nonce: connectNonce });
      } catch {
        sendTextFrame(socket, JSON.stringify({ type: "event", event: "weclaw.bridge.error", payload: { message: "Invalid browser WebSocket frame payload." } }));
        continue;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(outbound);
      else upstreamQueue.push(outbound);
    }
  });
  socket.on("close", () => upstream.close());
  socket.on("error", () => upstream.close());
}

function readConnectNonce(frameText: string): string | undefined {
  try {
    const frame = JSON.parse(frameText) as { type?: unknown; event?: unknown; payload?: { nonce?: unknown } };
    return frame.type === "event" && frame.event === "connect.challenge" && typeof frame.payload?.nonce === "string" ? frame.payload.nonce : undefined;
  } catch {
    return undefined;
  }
}

function safePathname(rawUrl?: string): string {
  try {
    return new URL(rawUrl || "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function acceptBrowserSocket(socket: Duplex, key: string): void {
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );
}

function readClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
    length = Number(bigLength);
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

function sendTextFrame(socket: Duplex, text: string): void {
  sendFrame(socket, 1, Buffer.from(text, "utf8"));
}

function sendCloseFrame(socket: Duplex, code: number, reason: string): void {
  const reasonBuffer = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  sendControlFrame(socket, 8, payload);
  socket.end();
}

function sendControlFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  sendFrame(socket, opcode, payload);
}

function sendFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = length;
  } else if (length <= 65535) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
