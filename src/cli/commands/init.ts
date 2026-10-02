import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  loadConfig,
  saveConfig,
  configDir,
  type StroodleConfig,
  type Capability,
} from "../../lib/config.js";
import { RegistryAPI } from "../../lib/api.js";

export const initCommand = new Command("init")
  .description("Scan project, register agent, write config")
  .option("--registry <url>", "Registry URL", "https://stroodle.ai")
  .option("--api-key <key>", "API key (or set STROODLE_API_KEY)")
  .action(async (opts) => {
    const projectDir = process.cwd();
    const rl = createInterface({ input: stdin, output: stdout });

    console.log("\n  Scanning project...\n");

    // Check existing config
    const existing = await loadConfig(projectDir);
    if (existing?.api_key) {
      const resume = await rl.question(
        "  Found existing .stroodle/config.json. Resume? [Y/n] "
      );
      if (resume.toLowerCase() === "n") {
        console.log("  Starting fresh.\n");
      } else {
        console.log("  Resuming with existing config.\n");
        rl.close();
        return;
      }
    }

    // Get API key
    let apiKey =
      opts.apiKey ?? process.env.STROODLE_API_KEY ?? existing?.api_key ?? "";
    if (!apiKey) {
      apiKey = await rl.question("  Enter your Stroodle API key: ");
      if (!apiKey.trim()) {
        console.error("  API key is required. Get one at stroodle.ai/settings");
        rl.close();
        process.exit(1);
      }
      apiKey = apiKey.trim();
    }

    const registryUrl = opts.registry;
    const api = new RegistryAPI(registryUrl, apiKey);

    // Scan project for capabilities
    const capabilities = await scanProject(projectDir);

    if (capabilities.length > 0) {
      console.log("  Found potential capabilities:");
      for (const cap of capabilities) {
        console.log(`    - ${cap.name}: ${cap.description}`);
      }
      console.log();
    } else {
      console.log("  No capabilities auto-detected.\n");
    }

    // Propose registration
    const projectName = projectDir.split("/").pop() ?? "my-agent";
    const name = await rl.question(
      `  Agent name [${projectName}]: `
    );
    const agentName = name.trim() || projectName;

    // Register capabilities
    let agentId: string | null = existing?.agent_id ?? null;
    for (const cap of capabilities) {
      const register = await rl.question(
        `  Register "${cap.name}"? [Y/n] `
      );
      if (register.toLowerCase() === "n") continue;
      try {
        const result = await api.registerCapability(cap);
        agentId = result.agent_id;
        console.log(`  Registered: ${cap.name}`);
      } catch (err) {
        console.error(
          `  Failed to register ${cap.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Save config
    const config: StroodleConfig = {
      agent_id: agentId,
      api_key: apiKey,
      registry_url: registryUrl,
      capabilities,
      daemon: {
        poll_interval_ms: 15_000,
        log_max_lines: 1000,
      },
    };
    await saveConfig(config, projectDir);
    console.log(`\n  Config saved to .stroodle/config.json`);

    // Patch .mcp.json
    await patchMcpConfig(projectDir);

    // Add .stroodle/ to .gitignore
    await ensureGitignore(projectDir);

    const startDaemon = await rl.question("\n  Start the daemon? [Y/n] ");
    rl.close();

    if (startDaemon.toLowerCase() !== "n") {
      console.log("  Run: stroodle start");
    }

    console.log(
      `\n  Done. Your agent is configured at ${configDir(projectDir)}`
    );
    console.log("  Run `stroodle start` to go online.\n");
  });

async function scanProject(projectDir: string): Promise<Capability[]> {
  const capabilities: Capability[] = [];

  // Check README
  const readmePath = join(projectDir, "README.md");
  if (existsSync(readmePath)) {
    const readme = await readFile(readmePath, "utf-8");
    // Simple heuristic: look for API/endpoint mentions
    if (/\b(api|endpoint|route)\b/i.test(readme)) {
      // Could do more sophisticated scanning here
    }
  }

  // Check package.json
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      if (pkg.description) {
        capabilities.push({
          name: pkg.name ?? "service",
          description: pkg.description,
          tags: pkg.keywords ?? [],
          price_hint: null,
        });
      }
    } catch {}
  }

  // Check pyproject.toml (basic)
  const pyprojectPath = join(projectDir, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    const content = await readFile(pyprojectPath, "utf-8");
    const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
    const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    if (descMatch) {
      capabilities.push({
        name: nameMatch?.[1] ?? "service",
        description: descMatch[1],
        tags: [],
        price_hint: null,
      });
    }
  }

  return capabilities;
}

async function patchMcpConfig(projectDir: string): Promise<void> {
  const mcpPath = join(projectDir, ".mcp.json");
  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(await readFile(mcpPath, "utf-8"));
    } catch {}
  }

  const servers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
  servers["stroodle-agent"] = {
    command: "npx",
    args: ["stroodle-agent", "mcp"],
    env: {
      STROODLE_PROJECT_DIR: projectDir,
    },
  };
  mcpConfig.mcpServers = servers;
  await writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log("  Updated .mcp.json with stroodle-agent MCP bridge");
}

async function ensureGitignore(projectDir: string): Promise<void> {
  const gitignorePath = join(projectDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (content.includes(".stroodle/")) return;
    await writeFile(gitignorePath, content.trimEnd() + "\n.stroodle/\n");
  } else {
    await writeFile(gitignorePath, ".stroodle/\n");
  }
}
