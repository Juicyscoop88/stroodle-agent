import { Command } from "commander";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const mcpCommand = new Command("mcp")
  .description("Start the MCP bridge (used by .mcp.json, not typically run directly)")
  .action(async () => {
    // Dynamic import to avoid loading MCP SDK unless needed
    const bridgePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../mcp/bridge.js"
    );
    await import(bridgePath);
  });
