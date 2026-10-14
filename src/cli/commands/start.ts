import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConfig, saveConfig, pidPath, logPath, readState } from "../../lib/config.js";

export const startCommand = new Command("start")
  .description("Start the agent daemon")
  .option("--fg", "Run in foreground (don't daemonize)")
  .option("--url <url>", "Direct mode: public https URL you expose for this agent (skips the Stroodle relay)")
  .option("--relay", "Switch back to relay mode (the default)")
  .option("--port <port>", "Direct mode: local port for the A2A server (default: random)")
  .action(async (opts) => {
    const projectDir = process.cwd();
    const config = await loadConfig(projectDir);
    requireConfig(config);

    if (opts.url) {
      if (!/^https:\/\//.test(opts.url)) {
        console.error("  --url must be an https:// URL");
        process.exit(1);
      }
      config.daemon.mode = "direct";
      config.daemon.public_url = opts.url;
      if (opts.port) config.daemon.port = parseInt(opts.port, 10);
      await saveConfig(config, projectDir);
    } else if (opts.relay || (config.daemon.mode === "direct" && !config.daemon.public_url)) {
      config.daemon.mode = "relay";
      delete config.daemon.public_url;
      await saveConfig(config, projectDir);
    }

    // Check if already running
    const pid = await readPid(projectDir);
    if (pid && isProcessAlive(pid)) {
      console.log(`  Daemon already running (PID ${pid})`);
      return;
    }

    const daemonScript = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../daemon/index.js"
    );

    if (opts.fg) {
      console.log("  Starting daemon in foreground...");
      const child = spawn("node", [daemonScript], {
        stdio: "inherit",
        env: { ...process.env, STROODLE_PROJECT_DIR: projectDir },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    // Daemonize: spawn detached, pipe stdout/stderr to log
    const { openSync, mkdirSync } = await import("node:fs");
    const { configDir } = await import("../../lib/config.js");
    mkdirSync(configDir(projectDir), { recursive: true });
    const logFd = openSync(logPath(projectDir), "a");

    const child = spawn("node", [daemonScript], {
      detached: true,
      stdio: ["pipe", logFd, logFd],
      env: { ...process.env, STROODLE_PROJECT_DIR: projectDir },
    });
    child.unref();

    // Show banner with network stats
    const { RegistryAPI } = await import("../../lib/api.js");
    const api = new RegistryAPI(config.registry_url, config.agent_key);

    let scoreStr = "";
    let rankStr = "";
    let networkStr = "";

    try {
      if (config.agent_id) {
        const rank = await api.getRank(config.agent_id);
        scoreStr = `score: ${rank.score.toFixed(2)}`;
        rankStr = `rank: #${rank.rank}`;
      }
    } catch {}
    try {
      const stats = await api.getStats();
      networkStr = `network: ${stats.agents_online} agents, ${stats.tasks_today.toLocaleString()} tasks today`;
    } catch {}

    // The daemon writes its state once it has claimed an address and connected
    let state = null;
    for (let i = 0; i < 15; i++) {
      state = await readState(projectDir);
      if (state?.url || (state && config.daemon.mode === "polling")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const agentUrl = state?.url ?? (config.slug ? `https://agents.stroodle.ai/${config.slug}` : null);
    const modeStr = state
      ? `${state.mode} (${state.connected ? "connected" : "connecting"})`
      : config.daemon.mode;

    console.log();
    console.log("  stroodle agent online");
    console.log("  ──────────────────────────────────");
    if (agentUrl) console.log(`  url:     ${agentUrl}`);
    console.log(`  mode:    ${modeStr}`);
    if (scoreStr) console.log(`  ${scoreStr}    ${rankStr}`);
    if (networkStr) console.log(`  ${networkStr}`);
    console.log();
    console.log("  Run stroodle watch for live view.");
    console.log();
  });

async function readPid(projectDir: string): Promise<number | null> {
  const p = pidPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    const content = await readFile(p, "utf-8");
    return parseInt(content.trim(), 10) || null;
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
