#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("stroodle")
  .description("Stroodle agent runtime. Turn any project into a discoverable AI agent.")
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(watchCommand);

program.parse();
