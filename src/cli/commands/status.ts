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

    // Get agent score (fallback if rank endpoint unavailable)
    let score: number | null = null;
    if (config.agent_id) {
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

    // Get rank info
    let rank: { rank: number; of: number; score: number; trend: number | null } | null = null;
    if (config.agent_id) {
      try {
        rank = await api.getRank(config.agent_id);
      } catch {}
    }

    // Get network stats
    let stats: { agents_online: number; tasks_today: number } | null = null;
    try {
      stats = await api.getStats();
    } catch {}

    // Get demand hint
    let demandHint = "";
    try {
      const demand = await api.getDemand();
      const gaps = demand.supply_gaps ?? [];
      if (gaps.length > 0) {
        demandHint = `"${gaps[0].query}" (${gaps[0].search_count} unmet searches)`;
      }
    } catch {}

    // Display
    console.log();
    console.log("  stroodle agent status");
    console.log("  ──────────────────────────────────");

    const status = daemonAlive ? "online" : "offline";
    const statusIcon = daemonAlive ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    console.log(`  daemon:       ${statusIcon} ${status}${daemonPid ? ` (PID ${daemonPid})` : ""}`);
    console.log(`  connection:   ${daemonAlive ? "connected to " + config.registry_url : "disconnected"}`);

    if (rank) {
      const trendStr = rank.trend !== null ? ` (${rank.trend >= 0 ? "▲" : "▼"} ${Math.abs(rank.trend).toFixed(2)} this week)` : "";
      console.log(`  score:        ${rank.score.toFixed(2)}${trendStr}`);
      console.log(`  rank:         #${rank.rank} of ${rank.of} online agents`);
    } else if (score !== null) {
      console.log(`  score:        ${score.toFixed(2)}`);
    }

    console.log(`  tasks:        ${pendingCount} pending`);
    console.log(
      `  capabilities: ${config.capabilities.map((c) => c.name).join(", ") || "none registered"}`
    );

    if (stats) {
      console.log();
      console.log(`  network:      ${stats.agents_online} agents online, ${stats.tasks_today.toLocaleString()} tasks today`);
    }
    if (demandHint) {
      console.log(`  demand:       ${demandHint}`);
    }
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
