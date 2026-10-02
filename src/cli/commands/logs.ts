import { Command } from "commander";
import { readLogs } from "../../lib/log.js";

export const logsCommand = new Command("logs")
  .description("Show daemon logs")
  .option("-n, --lines <n>", "Number of lines", "50")
  .action(async (opts) => {
    const projectDir = process.cwd();
    const lines = parseInt(opts.lines, 10) || 50;
    const output = await readLogs(lines, projectDir);
    console.log(output);
  });
