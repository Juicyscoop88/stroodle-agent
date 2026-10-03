import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadConfig,
  saveConfig,
  configDir,
  type StroodleConfig,
  type Capability,
} from "../../lib/config.js";
import { RegistryAPI } from "../../lib/api.js";

async function askUser(question: string, defaultValue = ""): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

export const initCommand = new Command("init")
  .description("Scan project, register agent, write config")
  .option("--registry <url>", "Registry URL", "https://stroodle.ai")
  .option("--api-key <key>", "API key (or set STROODLE_API_KEY)")
  .option("--name <name>", "Agent name (defaults to directory name)")
  .option("-y, --yes", "Non-interactive mode, accept all defaults")
  .action(async (opts) => {
    const projectDir = process.cwd();
    const nonInteractive = opts.yes || !isInteractive();

    console.log("\n  Scanning project...\n");

    // Check existing config
    const existing = await loadConfig(projectDir);
    if (existing?.api_key && !nonInteractive) {
      const resume = await askUser(
        "  Found existing .stroodle/config.json. Overwrite? [y/N] ",
        "n"
      );
      if (resume.toLowerCase() !== "y") {
        console.log("  Keeping existing config.\n");
        return;
      }
    }

    // Get API key
    let apiKey =
      opts.apiKey ?? process.env.STROODLE_API_KEY ?? existing?.api_key ?? "";
    if (!apiKey) {
      if (nonInteractive) {
        console.error(
          "  No API key found. Pass --api-key or set STROODLE_API_KEY.\n" +
            "  Get a key at stroodle.ai/settings"
        );
        process.exit(1);
      }
      apiKey = await askUser("  Enter your Stroodle API key: ");
      if (!apiKey) {
        console.error("  API key is required. Get one at stroodle.ai/settings");
        process.exit(1);
      }
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

    // Agent name
    const defaultName = opts.name ?? projectDir.split("/").pop() ?? "my-agent";
    let agentName = defaultName;
    if (!nonInteractive && !opts.name) {
      agentName = await askUser(`  Agent name [${defaultName}]: `, defaultName);
    }

    // Register capabilities
    let agentId: string | null = existing?.agent_id ?? null;
    for (const cap of capabilities) {
      let shouldRegister = nonInteractive;
      if (!nonInteractive) {
        const answer = await askUser(`  Register "${cap.name}"? [Y/n] `, "y");
        shouldRegister = answer.toLowerCase() !== "n";
      }
      if (!shouldRegister) continue;
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
    console.log(`  Config saved to .stroodle/config.json`);

    // Patch .mcp.json
    await patchMcpConfig(projectDir);

    // Add .stroodle/ to .gitignore
    await ensureGitignore(projectDir);

    console.log(
      `\n  Done. Your agent is configured at ${configDir(projectDir)}`
    );
    console.log("  Run `stroodle start` to go online.\n");
  });

async function scanProject(projectDir: string): Promise<Capability[]> {
  const capabilities: Capability[] = [];

  // Check package.json
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      if (pkg.description) {
        capabilities.push({
          name: pkg.name?.replace(/^@[^/]+\//, "") ?? "service",
          description: pkg.description,
          tags: pkg.keywords ?? [],
          price_hint: null,
        });
      }
    } catch {}
  }

  // Check pyproject.toml
  const pyprojectPath = join(projectDir, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
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
    } catch {}
  }

  return capabilities;
}

function resolveCliEntrypoint(): string {
  // Resolve to the actual installed location of the CLI
  // Works whether installed globally, via npx, or running from local build
  const cliIndex = resolve(
    new URL(".", import.meta.url).pathname,
    "../index.js"
  );
  return cliIndex;
}

async function patchMcpConfig(projectDir: string): Promise<void> {
  const mcpPath = join(projectDir, ".mcp.json");
  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(await readFile(mcpPath, "utf-8"));
    } catch {}
  }

  const cliEntry = resolveCliEntrypoint();
  const servers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
  servers["stroodle-agent"] = {
    command: "node",
    args: [cliEntry, "mcp"],
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
