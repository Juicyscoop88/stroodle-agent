#!/usr/bin/env node

import { writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RegistryAPI } from "../lib/api.js";
import {
  loadConfig,
  requireConfig,
  pidPath,
  configDir,
  statePath,
  type DaemonState,
} from "../lib/config.js";
import { appendLog } from "../lib/log.js";
import { ObservationSender } from "../lib/observations.js";
import { PollingTaskReceiver } from "./task-receiver.js";
import { RelayTaskReceiver } from "./relay-receiver.js";
import { A2AHttpServer } from "./http-server.js";
import { processTask, notifyOS } from "./task-worker.js";

const projectDir = process.env.STROODLE_PROJECT_DIR ?? process.cwd();

async function main() {
  const config = await loadConfig(projectDir);
  requireConfig(config);

  const api = new RegistryAPI(config.registry_url, config.agent_key);

  let observations: ObservationSender | null = null;
  if (config.agent_id && config.sharing.kinds.length > 0) {
    observations = new ObservationSender(api, config.agent_id, config.sharing);
    observations.start();
  }

  // Ensure config dir exists
  const dir = configDir(projectDir);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  // Write PID file
  const pid = process.pid;
  await writeFile(pidPath(projectDir), String(pid));
  await appendLog(`Daemon started (PID ${pid})`, "info", projectDir);

  const mode = config.daemon.mode;
  let publicUrl: string | null = null;

  async function writeState(connected: boolean, activeMode: DaemonState["mode"]) {
    const state: DaemonState = { mode: activeMode, connected, url: publicUrl };
    await writeFile(statePath(projectDir), JSON.stringify(state)).catch(() => {});
  }

  // Run one task through the Claude Code SDK. Returns null when processing is disabled.
  async function runTask(
    task: { task_id: string; message: string; depth?: number },
    reportObservation: boolean
  ): Promise<{ result: string; success: boolean } | null> {
    await appendLog(`Processing task ${task.task_id}: "${task.message}"`, "task", projectDir);
    if (!config!.processing?.enabled) {
      await appendLog(`Skipping task ${task.task_id} (processing disabled)`, "info", projectDir);
      return null;
    }
    const startTime = Date.now();
    let out: { result: string; success: boolean };
    try {
      const result = await processTask(task, { ...config!, project_dir: projectDir });
      out = { result, success: true };
      await appendLog(`Completed task ${task.task_id}`, "task", projectDir);
      notifyOS("Stroodle", `Task completed: ${task.message.slice(0, 60)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(`Failed task ${task.task_id}: ${msg}`, "error", projectDir);
      out = { result: `Error: ${msg}`, success: false };
    }
    if (reportObservation) {
      observations?.add({
        kind: "call_result",
        data: {
          success: out.success,
          duration_ms: Date.now() - startTime,
          source: mode === "direct" ? "self_reported" : "polling",
        },
      });
    }
    return out;
  }

  // Report through REST (polling, and relay fallback when the socket dropped mid-task)
  const completeViaRest = async (task: { task_id: string }, out: { result: string; success: boolean }) => {
    await api.completeTask(task.task_id, out.result, out.success);
  };

  function startPolling(): PollingTaskReceiver {
    const poller = new PollingTaskReceiver(api, config!.daemon.poll_interval_ms, projectDir);
    poller.onTask(async (task) => {
      const out = await runTask(task, true);
      if (out) await completeViaRest(task, out);
    });
    poller.start();
    return poller;
  }

  // Tell the registry how this agent is reached. The address (slug) was claimed by `init`.
  async function ensureAddress(wanted: DaemonState["mode"], url?: string) {
    if (!config!.agent_id) return;
    try {
      const res = await api.updateAddressing(config!.agent_id, { mode: wanted, public_url: url });
      publicUrl = wanted === "direct" ? res.url : res.url.replace(/\/a2a$/, "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(`Address registration failed: ${msg}`, "error", projectDir);
      if (wanted === "direct") throw err;
    }
  }

  let poller: PollingTaskReceiver | null = null;
  let relay: RelayTaskReceiver | null = null;
  let httpServer: A2AHttpServer | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  if (mode === "direct") {
    if (!config.daemon.public_url) throw new Error("direct mode needs daemon.public_url (stroodle start --url ...)");
    const base = config.daemon.public_url.replace(/\/+$/, "");
    httpServer = new A2AHttpServer(async (taskId, message) => {
      const out = await runTask({ task_id: taskId, message }, true);
      return out ?? { result: "Task processing is disabled on this agent", success: false };
    }, projectDir);
    const port = await httpServer.start(config.daemon.port);
    await appendLog(`Direct A2A server listening on port ${port}`, "info", projectDir);
    await ensureAddress("direct", `${base}/a2a`);
    await writeState(true, "direct");
    heartbeatTimer = setInterval(() => api.heartbeat().catch(() => {}), 60_000);
    console.log(`[stroodle] Agent online (PID ${pid}), direct mode on port ${port}, public ${base}/a2a`);
  } else if (mode === "relay") {
    await ensureAddress("relay");
    relay = new RelayTaskReceiver(config.registry_url, config.agent_key, {
      onConnected: () => {
        if (poller) {
          poller.stop();
          poller = null;
          appendLog("Relay back, polling stopped", "info", projectDir).catch(() => {});
        }
        writeState(true, "relay");
      },
      onDisconnected: (failures) => {
        writeState(false, poller ? "polling" : "relay");
        if (failures >= 3 && !poller) {
          console.log("[stroodle] Relay unreachable, falling back to polling (will keep retrying relay).");
          appendLog("Relay unreachable, polling fallback active", "error", projectDir).catch(() => {});
          poller = startPolling();
          writeState(false, "polling");
        }
      },
    }, projectDir);
    relay.onTask(async (task) => {
      // Registry records latency/outcome for relayed tasks itself (verified data)
      const out = await runTask(task, false);
      if (!out) return;
      if (!relay!.sendResult(task.task_id, out.result, out.success)) {
        await completeViaRest(task, out).catch((err) =>
          appendLog(`Could not report task ${task.task_id}: ${err}`, "error", projectDir)
        );
      }
    });
    relay.start();
    await writeState(false, "relay");
    console.log(`[stroodle] Agent online (PID ${pid}), relay mode`);
  } else {
    await ensureAddress("polling");
    poller = startPolling();
    await writeState(false, "polling");
    console.log(`[stroodle] Agent online (PID ${pid}), polling every ${config.daemon.poll_interval_ms / 1000}s`);
  }

  // Collect and send tool schemas on startup
  if (observations) {
    await observations.collectAndSendToolSchemas(projectDir);
  }

  // Initial heartbeat to go online
  const heartbeatStart = Date.now();
  try {
    await api.heartbeat();
    await appendLog("Agent is online", "info", projectDir);
    observations?.add({
      kind: "heartbeat",
      data: { latency_ms: Date.now() - heartbeatStart },
    });
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
    relay?.stop();
    poller?.stop();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (httpServer) await httpServer.stop();
    try {
      await unlink(statePath(projectDir));
    } catch {}
    if (observations) {
      observations.stop();
      await observations.flush().catch(() => {});
    }
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
