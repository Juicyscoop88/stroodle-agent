#!/usr/bin/env node

import { writeFile, unlink } from "node:fs/promises";
import { RegistryAPI, type InboxTask } from "../lib/api.js";
import {
  loadConfig,
  requireConfig,
  pidPath,
  configDir,
} from "../lib/config.js";
import { appendLog } from "../lib/log.js";
import { PollingTaskReceiver } from "./task-receiver.js";

const projectDir = process.env.STROODLE_PROJECT_DIR ?? process.cwd();

async function main() {
  const config = await loadConfig(projectDir);
  requireConfig(config);

  const api = new RegistryAPI(config.registry_url, config.api_key);
  const receiver = new PollingTaskReceiver(
    api,
    config.daemon.poll_interval_ms,
    projectDir
  );

  // Write PID file
  const pid = process.pid;
  await writeFile(pidPath(projectDir), String(pid));
  await appendLog(`Daemon started (PID ${pid})`, "info", projectDir);

  // Pending tasks queue — MCP bridge reads from this
  const pendingTasks: InboxTask[] = [];

  receiver.onTask((task) => {
    pendingTasks.push(task);
    console.log(
      JSON.stringify({ type: "task", task_id: task.task_id, message: task.message })
    );
  });

  receiver.start();

  // Initial heartbeat to go online
  try {
    await api.heartbeat();
    await appendLog("Agent is online", "info", projectDir);
  } catch (err) {
    await appendLog(
      `Initial heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
      projectDir
    );
  }

  // IPC: listen on stdin for commands from CLI/MCP bridge
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (data: string) => {
    try {
      const msg = JSON.parse(data.trim());
      if (msg.type === "get_pending") {
        console.log(JSON.stringify({ type: "pending", tasks: pendingTasks }));
      } else if (msg.type === "complete_task") {
        await api.completeTask(msg.task_id, msg.result, msg.success ?? true);
        const idx = pendingTasks.findIndex((t) => t.task_id === msg.task_id);
        if (idx !== -1) pendingTasks.splice(idx, 1);
        await appendLog(`Task ${msg.task_id} completed`, "task", projectDir);
        console.log(
          JSON.stringify({ type: "task_completed", task_id: msg.task_id })
        );
      } else if (msg.type === "status") {
        const agentId = config.agent_id;
        let score = null;
        if (agentId) {
          try {
            score = await api.getScore(agentId);
          } catch {}
        }
        console.log(
          JSON.stringify({
            type: "status",
            pid,
            agent_id: agentId,
            pending_count: pendingTasks.length,
            score,
            uptime_s: Math.floor(process.uptime()),
          })
        );
      }
    } catch {
      // ignore malformed input
    }
  });

  async function shutdown() {
    await appendLog("Daemon shutting down", "info", projectDir);
    receiver.stop();
    try {
      await api.heartbeat(true);
    } catch {}
    try {
      await unlink(pidPath(projectDir));
    } catch {}
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(async (err) => {
  await appendLog(
    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
    "error",
    projectDir
  );
  process.exit(1);
});
