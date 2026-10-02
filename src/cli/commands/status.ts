import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig, requireConfig, pidPath } from "../../lib/config.js";
import { RegistryAPI } from "../../lib/api.js";

export const statusCommand = new Command("status")
  .description("Show agent health, tasks, and score")
  .action(async () => {
    const projectDir = process.cwd();
    const config = await loadConfig(projectDir);
    requireConfig(config);

    const api = new RegistryAPI(config.registry_url, config.api_key);

    // Check daemon
    const daemonPid = await getDaemonPid(projectDir);
    const daemonAlive = daemonPid !== null && isProcessAlive(daemonPid);

    // Get agent info
    let agentInfo: Record<string, unknown> | null = null;
    let score: number | null = null;
    if (config.agent_id) {
      try {
        agentInfo = (await api.getAgent(config.agent_id)) as Record<string, unknown>;
      } catch {}
      try {
        const s = await api.getScore(config.agent_id);
        score = s.score;
      } catch {}
    }

    // Get pending tasks
    let pendingCount = 0;
    try {
      const hb = await api.heartbeat();
      pendingCount = hb.pending_tasks;
    } catch {}

    // Display
    console.log();
    const status = daemonAlive ? "online" : "offline";
    const statusIcon = daemonAlive ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    console.log(`  ${statusIcon} agent ${status}${daemonPid ? ` · PID ${daemonPid}` : ""}`);

    if (score !== null) {
      const bar = renderBar(score);
      console.log(`  Reputation     ${bar} ${score.toFixed(1)}`);
    }

    console.log(`  Pending tasks  ${pendingCount}`);
    console.log(
      `  Capabilities   ${config.capabilities.map((c) => c.name).join(", ") || "none registered"}`
    );
    console.log(`  Registry       ${config.registry_url}`);
    console.log();
  });

function renderBar(score: number, width = 14): string {
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function getDaemonPid(projectDir: string): Promise<number | null> {
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
