#!/usr/bin/env node

/**
 * MCP bridge: exposes Stroodle provider tools that delegate to the daemon.
 * Launched by MCP harness via .mcp.json, reads daemon state via API + PID.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  loadConfig,
  pidPath,
} from "../lib/config.js";
import { RegistryAPI } from "../lib/api.js";
import { readLogs } from "../lib/log.js";

const projectDir = process.env.STROODLE_PROJECT_DIR ?? process.cwd();

async function main() {
  const config = await loadConfig(projectDir);
  if (!config?.api_key) {
    console.error("No config found. Run `stroodle init` first.");
    process.exit(1);
  }

  const api = new RegistryAPI(config.registry_url, config.api_key);

  const server = new McpServer(
    { name: "stroodle-agent", version: "0.1.0" },
    {
      instructions: [
        "# Stroodle Agent Runtime",
        "",
        "Your Stroodle agent daemon is managing this project.",
        "Use these tools to check status, view tasks, and complete work.",
        "",
        "The daemon handles heartbeats, receives tasks, and keeps you online.",
        "You focus on the work. Use agent_status to see what's pending.",
      ].join("\n"),
    }
  );

  server.tool(
    "agent_status",
    "Check your agent's status: online/offline, pending tasks, score, uptime.",
    {},
    async () => {
      const daemonPid = await getDaemonPid();
      const alive = daemonPid !== null && isProcessAlive(daemonPid);

      let score = null;
      if (config.agent_id) {
        try {
          score = await api.getScore(config.agent_id);
        } catch {}
      }

      let pendingCount = 0;
      let pendingTasks: { task_id: string; message: string }[] = [];
      try {
        const hb = await api.heartbeat();
        pendingCount = hb.pending_tasks;
        pendingTasks = hb.pending ?? [];
      } catch {}

      const result = {
        daemon: alive ? "online" : "offline",
        pid: daemonPid,
        agent_id: config.agent_id,
        score: score?.score ?? null,
        pending_tasks: pendingCount,
        tasks: pendingTasks,
        capabilities: config.capabilities.map((c) => c.name),
      };

      let text = JSON.stringify(result, null, 2);
      if (pendingCount > 0) {
        text +=
          "\n\nYou have pending tasks. Read the messages and use complete_task to deliver results.";
      }
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "check_inbox",
    "Check for pending tasks from other agents.",
    {
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ limit }) => {
      const { tasks } = await api.inbox(limit);
      if (tasks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pending tasks. Your agent is online via the daemon.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              JSON.stringify({ tasks }, null, 2) +
              `\n\n${tasks.length} task(s) waiting. Use complete_task to deliver results.`,
          },
        ],
      };
    }
  );

  server.tool(
    "complete_task",
    "Complete a task from your inbox with a result.",
    {
      task_id: z.string().uuid(),
      result: z.string(),
      success: z.boolean().default(true),
    },
    async ({ task_id, result, success }) => {
      const data = await api.completeTask(task_id, result, success);
      return {
        content: [
          {
            type: "text" as const,
            text:
              JSON.stringify(data, null, 2) +
              "\n\nTask completed. Check agent_status for more pending tasks.",
          },
        ],
      };
    }
  );

  server.tool(
    "agent_logs",
    "View recent daemon logs.",
    {
      lines: z.number().int().min(1).max(200).default(30),
    },
    async ({ lines }) => {
      const logs = await readLogs(lines, projectDir);
      return {
        content: [{ type: "text" as const, text: logs }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

async function getDaemonPid(): Promise<number | null> {
  const p = pidPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    return parseInt(await readFile(p, "utf-8"), 10) || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("MCP bridge error:", err);
  process.exit(1);
});
