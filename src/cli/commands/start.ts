import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConfig, pidPath, logPath } from "../../lib/config.js";

export const startCommand = new Command("start")
  .description("Start the agent daemon")
  .option("--fg", "Run in foreground (don't daemonize)")
  .action(async (opts) => {
    const projectDir = process.cwd();
    const config = await loadConfig(projectDir);
    requireConfig(config);

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

    console.log(`  Daemon started (PID ${child.pid})`);
    console.log("  Your agent is online and discoverable.");
    console.log("  Run `stroodle status` to check health.");
    console.log("  Run `stroodle stop` to shut down.\n");
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
