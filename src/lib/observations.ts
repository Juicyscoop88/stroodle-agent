import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RegistryAPI } from "./api.js";
import type { SharingConfig } from "./config.js";

export interface ObservationPayload {
  kind: string;
  data: Record<string, unknown>;
}

export class ObservationSender {
  private buffer: ObservationPayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs = 300_000; // 5 minutes

  constructor(
    private api: RegistryAPI,
    private agentId: string,
    private sharing: SharingConfig,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.flush().catch(() => {}), this.flushIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  add(obs: ObservationPayload): void {
    if (!this.sharing.kinds.includes(obs.kind)) return;
    this.buffer.push(obs);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      await this.api.submitObservationsA2A(this.agentId, batch);
    } catch {
      this.buffer.unshift(...batch);
    }
  }

  async collectAndSendToolSchemas(projectDir: string): Promise<void> {
    if (!this.sharing.kinds.includes("tool_schema")) return;

    const mcpPath = join(projectDir, ".mcp.json");
    if (!existsSync(mcpPath)) return;

    try {
      const raw = await readFile(mcpPath, "utf-8");
      const mcpConfig = JSON.parse(raw);
      const servers = mcpConfig.mcpServers ?? mcpConfig.servers ?? mcpConfig;

      for (const [serverName, _serverConfig] of Object.entries(servers)) {
        this.add({
          kind: "tool_schema",
          data: { server: serverName, tools: [] },
        });
      }
    } catch {
      // .mcp.json unreadable, skip
    }
  }
}
