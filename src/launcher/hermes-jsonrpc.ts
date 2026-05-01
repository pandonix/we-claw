import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { delimiter } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { LauncherConfig } from "./config.js";
import { redact } from "./redact.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const MAX_LOG_LINES = 80;
const MAX_LOG_LINE_BYTES = 4096;

// Hermes TUI Gateway uses newline-delimited JSON-RPC over stdio, matching
// ui-tui's gateway client. This is not LSP Content-Length framing.
export interface HermesGatewayEvent {
  type: string;
  session_id?: string;
  payload?: unknown;
}

export interface HermesJsonRpcStatus {
  running: boolean;
  ready: boolean;
  stderrTail: string;
  lastError?: string;
}

interface PendingRequest {
  id: string;
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface HermesChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type HermesSpawnFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams | HermesChildProcess;

export class HermesProtocolError extends Error {
  constructor(message: string, readonly code = "hermes.protocol") {
    super(message);
    this.name = "HermesProtocolError";
  }
}

export class HermesJsonRpcClient {
  private child?: HermesChildProcess;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: HermesGatewayEvent) => void>();
  private readonly stderrLines: string[] = [];
  private stdoutRl?: ReadlineInterface;
  private stderrRl?: ReadlineInterface;
  private ready = false;
  private starting?: Promise<void>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private lastError?: string;

  constructor(
    private readonly config: LauncherConfig,
    private readonly spawnFactory: HermesSpawnFactory = spawn
  ) {}

  onEvent(listener: (event: HermesGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) throw new Error("Hermes gateway is not running.");

    const id = `h${this.nextId++}`;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesProtocolError(`Hermes request timed out: ${method}`, "hermes.request-timeout"));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        id,
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      try {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async start(): Promise<void> {
    if (this.ready && this.child && !this.child.killed && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    if (!this.config.hermesRoot) {
      throw new Error("Hermes root is not configured. Set WE_CLAW_HERMES_ROOT before using WE_CLAW_RUNTIME=hermes.");
    }

    this.starting = new Promise<void>((resolve, reject) => {
      this.ready = false;
      this.lastError = undefined;
      this.disposeChild();

      const envPythonPath = process.env.PYTHONPATH?.trim();
      const env = {
        ...process.env,
        PYTHONPATH: envPythonPath ? `${this.config.hermesRoot}${delimiter}${envPythonPath}` : this.config.hermesRoot
      };

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.starting = undefined;
        if (this.readyTimer) {
          clearTimeout(this.readyTimer);
          this.readyTimer = undefined;
        }
        if (error) reject(error);
        else resolve();
      };

      this.readyTimer = setTimeout(() => {
        const error = new HermesProtocolError(
          `Hermes gateway startup timed out after ${this.config.hermesStartupTimeoutMs}ms.${this.stderrTailForMessage()}`,
          "hermes.startup-timeout"
        );
        this.lastError = error.message;
        this.disposeChild();
        settle(error);
      }, this.config.hermesStartupTimeoutMs);
      this.readyTimer.unref?.();

      try {
        this.child = this.spawnFactory(this.config.hermesPython, ["-m", "tui_gateway.entry"], {
          cwd: this.config.hermesCwd,
          env,
          stdio: ["pipe", "pipe", "pipe"]
        }) as HermesChildProcess;
      } catch (error) {
        const spawnError = error instanceof Error ? error : new Error(String(error));
        this.lastError = redact(spawnError.message);
        settle(new Error(`Failed to start Hermes gateway: ${this.lastError}`));
        return;
      }

      this.stdoutRl = createInterface({ input: this.child.stdout });
      this.stdoutRl.on("line", (line) => this.handleStdoutLine(line, settle));
      this.stderrRl = createInterface({ input: this.child.stderr });
      this.stderrRl.on("line", (line) => this.captureStderr(line));
      this.child.on("error", (error) => {
        this.lastError = redact(error.message);
        this.rejectAll(new Error(`Hermes gateway error: ${this.lastError}`));
        settle(new Error(`Hermes gateway error: ${this.lastError}`));
      });
      this.child.on("exit", (code, signal) => {
        const message = `Hermes gateway exited with code ${code ?? "none"} signal ${signal ?? "none"}.${this.stderrTailForMessage()}`;
        this.ready = false;
        this.lastError = message;
        this.rejectAll(new Error(message));
        settle(new Error(message));
      });
    });

    return this.starting;
  }

  getStatus(): HermesJsonRpcStatus {
    return {
      running: Boolean(this.child && !this.child.killed && this.child.exitCode === null),
      ready: this.ready,
      stderrTail: this.getStderrTail(),
      lastError: this.lastError
    };
  }

  getStderrTail(limit = 20): string {
    return this.stderrLines.slice(-Math.max(1, limit)).join("\n");
  }

  dispose(): void {
    this.disposeChild();
    this.rejectAll(new Error("Hermes gateway disposed."));
    this.listeners.clear();
  }

  private handleStdoutLine(raw: string, settleStart: (error?: Error) => void): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const error = new HermesProtocolError(`Hermes gateway emitted malformed JSON: ${redact(raw.slice(0, 240))}`, "hermes.protocol-json");
      this.lastError = error.message;
      settleStart(error);
      return;
    }

    const id = typeof message.id === "string" ? message.id : typeof message.id === "number" ? String(message.id) : undefined;
    if (id && this.pending.has(id)) {
      this.settleRequest(id, message);
      return;
    }

    if (message.method !== "event") return;
    const event = asHermesGatewayEvent(message.params);
    if (!event) return;
    if (event.type === "gateway.ready") {
      this.ready = true;
      settleStart();
    }
    for (const listener of this.listeners) listener(event);
  }

  private settleRequest(id: string, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (message.error) {
      pending.reject(jsonRpcError(message.error, pending.method));
    } else {
      pending.resolve(message.result);
    }
  }

  private captureStderr(raw: string): void {
    const text = redact(raw.trim());
    if (!text) return;
    this.stderrLines.push(truncate(text, MAX_LOG_LINE_BYTES));
    if (this.stderrLines.length > MAX_LOG_LINES) this.stderrLines.splice(0, this.stderrLines.length - MAX_LOG_LINES);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private disposeChild(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = undefined;
    this.stderrRl = undefined;
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.ready = false;
  }

  private stderrTailForMessage(): string {
    const tail = this.getStderrTail();
    return tail ? ` Recent stderr:\n${tail}` : "";
  }
}

function asHermesGatewayEvent(value: unknown): HermesGatewayEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.type === "string" ? (record as unknown as HermesGatewayEvent) : undefined;
}

function jsonRpcError(value: unknown, method: string): Error {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : `Hermes request failed: ${method}`;
    const code = typeof record.code === "number" || typeof record.code === "string" ? ` (${record.code})` : "";
    return new HermesProtocolError(`${message}${code}`, "hermes.request-error");
  }
  return new HermesProtocolError(`Hermes request failed: ${method}`, "hermes.request-error");
}

function truncate(value: string, maxBytes: number): string {
  return value.length > maxBytes ? `${value.slice(0, maxBytes)}... [truncated ${value.length} chars]` : value;
}
