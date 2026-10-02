import { RegistryAPI, type InboxTask } from "../lib/api.js";
import { appendLog } from "../lib/log.js";

export type TaskHandler = (task: InboxTask) => void;

export interface TaskReceiver {
  start(): void;
  stop(): void;
  onTask(handler: TaskHandler): void;
}

export class PollingTaskReceiver implements TaskReceiver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers: TaskHandler[] = [];
  private seenTaskIds = new Set<string>();

  constructor(
    private api: RegistryAPI,
    private intervalMs: number,
    private projectDir?: string
  ) {}

  onTask(handler: TaskHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const hb = await this.api.heartbeat();
      if (hb.pending_tasks === 0) return;

      const { tasks } = await this.api.inbox();
      for (const task of tasks) {
        if (this.seenTaskIds.has(task.task_id)) continue;
        this.seenTaskIds.add(task.task_id);
        await appendLog(
          `New task ${task.task_id}: "${task.message}"`,
          "task",
          this.projectDir
        );
        for (const handler of this.handlers) {
          handler(task);
        }
      }

      // prevent memory leak: trim seen set when it gets large
      if (this.seenTaskIds.size > 10_000) {
        const keep = new Set(tasks.map((t) => t.task_id));
        this.seenTaskIds = keep;
      }
    } catch (err) {
      await appendLog(
        `Poll error: ${err instanceof Error ? err.message : String(err)}`,
        "error",
        this.projectDir
      );
    }
  }
}
