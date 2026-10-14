import WebSocket from "ws";
import { appendLog } from "../lib/log.js";
import type { TaskHandler, TaskReceiver } from "./task-receiver.js";

const PING_INTERVAL_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export interface RelayEvents {
  onConnected?: () => void;
  onDisconnected?: (consecutiveFailures: number) => void;
}

/**
 * Receives tasks over an outbound WebSocket to the registry relay (spec 038).
 * No public address needed. Reconnects with exponential backoff.
 */
export class RelayTaskReceiver implements TaskReceiver {
  private handlers: TaskHandler[] = [];
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;
  private backoff = MIN_BACKOFF_MS;
  private seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  connected = false;

  constructor(
    private registryUrl: string,
    private apiKey: string,
    private events: RelayEvents = {},
    private projectDir?: string
  ) {}

  onTask(handler: TaskHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private relayUrl(): string {
    const u = new URL("/v1/relay", this.registryUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    return u.toString();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.relayUrl(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.failures = 0;
      this.backoff = MIN_BACKOFF_MS;
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_INTERVAL_MS);
      appendLog("Relay connected", "info", this.projectDir).catch(() => {});
      this.events.onConnected?.();
    });

    ws.on("message", (raw) => {
      let msg: { type?: string; task_id?: string; message?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "task" && msg.task_id && msg.message !== undefined) {
        this.enqueue(msg.task_id, msg.message);
      }
    });

    ws.on("error", (err) => {
      appendLog(`Relay error: ${err.message}`, "error", this.projectDir).catch(() => {});
    });

    ws.on("close", (code) => {
      this.clearPing();
      const wasConnected = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (!wasConnected) this.failures++;
      this.events.onDisconnected?.(this.failures);
      if (this.stopped) return;
      // 4401: bad API key, retrying won't help quickly
      const delay = code === 4401 ? MAX_BACKOFF_MS : this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // One task at a time (Claude Code SDK). Later tasks wait in the local queue.
  private enqueue(taskId: string, message: string): void {
    if (this.seen.has(taskId)) return;
    this.seen.add(taskId);
    if (this.seen.size > 10_000) this.seen = new Set([taskId]);
    this.queue = this.queue.then(async () => {
      this.send({ type: "ack", task_id: taskId });
      await appendLog(`New task ${taskId}: "${message}"`, "task", this.projectDir);
      for (const handler of this.handlers) {
        await handler({ task_id: taskId, message });
      }
    }).catch(() => {});
  }

  /** Report a result. Used by the daemon's task handler. */
  sendResult(taskId: string, result: string, success: boolean): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: "result", task_id: taskId, result, success });
    return true;
  }
}
