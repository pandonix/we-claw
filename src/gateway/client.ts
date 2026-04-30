import type { GatewayCapabilities, GatewayFrame } from "../shared/types";

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent) => void): void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type GatewayEventHandler = (event: GatewayFrame) => void;

export interface GatewayClientOptions {
  token?: string;
  clientId?: string;
  clientMode?: string;
  clientVersion?: string;
  platform?: string;
}

export function parseGatewayFrame(raw: unknown): GatewayFrame {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Gateway frame must be an object");
  }
  const frame = value as GatewayFrame;
  if (typeof frame.type !== "string") {
    throw new Error("Gateway frame is missing type");
  }
  return frame;
}

export function capabilitiesFromHello(value: unknown): GatewayCapabilities {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const features = record.features && typeof record.features === "object" ? (record.features as Record<string, unknown>) : record;
  const methods = Array.isArray(features.methods) ? features.methods : Array.isArray(record.methods) ? record.methods : [];
  return {
    methods: new Set(methods.filter((method): method is string => typeof method === "string"))
  };
}

export class GatewayClient {
  private socket?: WebSocketLike;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<GatewayEventHandler>();
  private connectParamsSent = false;
  private connectTimer?: ReturnType<typeof setTimeout>;
  capabilities: GatewayCapabilities = { methods: new Set() };

  constructor(
    private readonly url: string,
    private readonly socketCtor: WebSocketCtor = WebSocket as unknown as WebSocketCtor,
    private readonly options: GatewayClientOptions = {}
  ) {}

  connect(): Promise<void> {
    this.socket = new this.socketCtor(this.url);

    return new Promise((resolve, reject) => {
      const onOpen = () => {
        this.connectTimer = setTimeout(() => this.sendConnectRequest(), 750);
      };
      const onError = () => {
        cleanup();
        reject(new Error("Gateway WebSocket connection failed"));
      };
      const onConnected = (frame: GatewayFrame) => {
        if (frame.type !== "connected") return;
        cleanup();
        this.listeners.delete(onConnected);
        this.listeners.delete(onFailed);
        resolve();
      };
      const onFailed = (frame: GatewayFrame) => {
        if (frame.type !== "connect.error") return;
        cleanup();
        this.listeners.delete(onConnected);
        this.listeners.delete(onFailed);
        reject(new Error(errorMessage(frame.error)));
      };
      const cleanup = () => {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.socket?.removeEventListener("open", onOpen);
        this.socket?.removeEventListener("error", onError);
      };

      this.listeners.add(onConnected);
      this.listeners.add(onFailed);
      this.socket?.addEventListener("open", onOpen);
      this.socket?.addEventListener("error", onError);
      this.socket?.addEventListener("message", this.handleMessage);
      this.socket?.addEventListener("close", this.handleClose);
    });
  }

  disconnect(): void {
    this.socket?.close();
    this.rejectAll(new Error("Gateway disconnected"));
  }

  onEvent(handler: GatewayEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  request(method: string, params: unknown = {}, timeoutMs = 15000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error("Gateway is not connected"));
    }

    const id = String(this.nextId++);
    const frame = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(JSON.stringify(frame));
    });
  }

  private readonly handleMessage = (event: Event | MessageEvent) => {
    const raw = "data" in event ? event.data : undefined;
    let frame: GatewayFrame;
    try {
      frame = parseGatewayFrame(raw);
    } catch (error) {
      this.emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (frame.type === "event" && frame.event === "connect.challenge") {
      this.sendConnectRequest();
      return;
    }

    if (frame.type === "hello" || frame.type === "connected") {
      this.capabilities = capabilitiesFromHello(frame.result ?? frame.params ?? frame.data);
      this.emit(frame);
      return;
    }

    if ((frame.type === "res" || frame.type === "response") && frame.id !== undefined) {
      const pending = this.pending.get(String(frame.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(frame.id));
      if (frame.error || (frame as { ok?: boolean }).ok === false) {
        pending.reject(new Error(errorMessage(frame.error)));
      } else {
        pending.resolve((frame as { payload?: unknown }).payload ?? frame.result ?? frame.data);
      }
      return;
    }

    this.emit(frame);
  };

  private readonly handleClose = () => {
    this.rejectAll(new Error("Gateway disconnected"));
    this.emit({ type: "shutdown" });
  };

  private sendConnectRequest(): void {
    if (this.connectParamsSent || !this.socket || this.socket.readyState !== 1) return;
    this.connectParamsSent = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const auth = this.options.token ? { token: this.options.token } : undefined;
    this.request("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.options.clientId ?? "gateway-client",
        displayName: "We-Claw",
        version: this.options.clientVersion ?? "0.1.0",
        platform: this.options.platform ?? navigator.platform ?? "web",
        mode: this.options.clientMode ?? "backend",
        instanceId: "we-claw-browser"
      },
      caps: ["tool-events"],
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      auth
    })
      .then((hello) => {
        this.capabilities = capabilitiesFromHello(hello);
        this.emit({ type: "connected", result: hello });
      })
      .catch((error) => {
        this.emit({ type: "connect.error", error });
      });
  }

  private emit(frame: GatewayFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    const details = record.details && typeof record.details === "object" ? (record.details as Record<string, unknown>) : undefined;
    const code = typeof details?.code === "string" ? details.code : typeof record.code === "string" ? record.code : undefined;
    return code ? `${message ?? "Gateway request failed"} (${code})` : message ?? JSON.stringify(error);
  }
  return String(error ?? "Gateway request failed");
}
