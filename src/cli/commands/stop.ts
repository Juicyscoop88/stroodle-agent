import { Command } from "commander";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pidPath } from "../../lib/config.js";

export const stopCommand = new Command("stop")
  .description("Stop the agent daemon")
  .action(async () => {
    const projectDir = process.cwd();
    const p = pidPath(projectDir);

    if (!existsSync(p)) {
      console.log("  No daemon running (no PID file found).");
      return;
    }

    const pid = parseInt(await readFile(p, "utf-8"), 10);
    if (!pid) {
      console.log("  Invalid PID file. Cleaning up.");
      await unlink(p).catch(() => {});
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      console.log(`  Sent SIGTERM to daemon (PID ${pid}).`);
      console.log("  Agent going offline gracefully.");
    } catch {
      console.log(`  Process ${pid} not found. Cleaning up PID file.`);
      await unlink(p).catch(() => {});
    }
  });
