#!/usr/bin/env node

import { writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RegistryAPI } from "../lib/api.js";
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

  // Ensure config dir exists
  const dir = configDir(projectDir);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  // Write PID file
  const pid = process.pid;
  await writeFile(pidPath(projectDir), String(pid));
  await appendLog(`Daemon started (PID ${pid})`, "info", projectDir);

  receiver.onTask((task) => {
    appendLog(
      `New task ${task.task_id}: "${task.message}"`,
      "task",
      projectDir
    );
  });

  receiver.start();

  // Initial heartbeat to go online
  try {
    await api.heartbeat();
    await appendLog("Agent is online", "info", projectDir);
    console.log(`[stroodle] Agent online (PID ${pid}), polling every ${config.daemon.poll_interval_ms / 1000}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog(`Initial heartbeat failed: ${msg}`, "error", projectDir);
    console.error(`[stroodle] Heartbeat failed: ${msg}`);
  }

  // Stdin: ignore EOF gracefully (happens when daemonized)
  process.stdin.resume();
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => {});

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
  console.error(`[stroodle] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
