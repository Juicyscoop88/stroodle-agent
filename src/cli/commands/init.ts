import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  .option("--api-key <key>", "Account key, used once to create the agent and never saved (or set STROODLE_API_KEY)")
  .option("--name <name>", "Agent name (defaults to directory name)")
  .option("--slug <slug>", "Public address: agents.stroodle.ai/<slug> (defaults to the agent name)")
  .option("-y, --yes", "Non-interactive mode, accept all defaults")
  .action(async (opts) => {
    const projectDir = process.cwd();
    const nonInteractive = opts.yes || !isInteractive();

    console.log("\n  Scanning project...\n");

    // Existing project agent? Then init only refreshes its capabilities, with the agent's own key.
    const existing = await loadConfig(projectDir);
    const hasAgent = Boolean(existing?.agent_key && existing?.agent_id);
    if (hasAgent && !nonInteractive) {
      const resume = await askUser(
        `  Found agent "${existing!.slug}" in .stroodle/config.json. Update its capabilities? [Y/n] `,
        "y"
      );
      if (resume.toLowerCase() === "n") {
        console.log("  Keeping existing config.\n");
        return;
      }
    }

    const registryUrl = opts.registry;

    // The account key creates the agent. It is used here only and is never written to disk.
    async function getAccountApi(): Promise<RegistryAPI> {
      let key = opts.apiKey ?? process.env.STROODLE_API_KEY ?? "";
      if (!key) {
        if (nonInteractive) {
          console.error(
            "  No account key found. Pass --api-key or set STROODLE_API_KEY.\n" +
              "  Get one at stroodle.ai/settings"
          );
          process.exit(1);
        }
        key = await askUser("  Enter your Stroodle account key (not saved): ");
        if (!key) {
          console.error("  An account key is required. Get one at stroodle.ai/settings");
          process.exit(1);
        }
      }
      return new RegistryAPI(registryUrl, key);
    }

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

    // Choose which capabilities to register
    const chosen: Capability[] = [];
    for (const cap of capabilities) {
      let shouldRegister = true;
      if (!nonInteractive) {
        const answer = await askUser(`  Register "${cap.name}"? [Y/n] `, "y");
        shouldRegister = answer.toLowerCase() !== "n";
      }
      if (shouldRegister) chosen.push(cap);
    }

    let agentId: string | null = existing?.agent_id ?? null;
    let agentKey = existing?.agent_key ?? "";
    let agentName = existing?.agent_name ?? opts.name ?? projectDir.split("/").pop() ?? "my-agent";
    let slug: string = existing?.slug ?? "";

    if (hasAgent) {
      const agentApi = new RegistryAPI(registryUrl, agentKey);
      for (const cap of chosen) {
        try {
          await agentApi.addCapability(agentId!, cap);
          console.log(`  Registered: ${cap.name}`);
        } catch (err) {
          console.error(
            `  Failed to register ${cap.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } else {
      const accountApi = await getAccountApi();

      // Agent name
      const defaultName = opts.name ?? projectDir.split("/").pop() ?? "my-agent";
      agentName = defaultName;
      if (!nonInteractive && !opts.name) {
        agentName = await askUser(`  Agent name [${defaultName}]: `, defaultName);
      }

      // Public address (agents.stroodle.ai/<slug>)
      slug = opts.slug ?? agentName;
      try {
        const check = await accountApi.slugAvailable(slug);
        slug = check.available ? check.slug : (check.suggestion ?? check.slug);
        if (!check.available) console.log(`  "${check.slug}" is taken, suggesting "${slug}".`);
      } catch {}
      if (!nonInteractive) {
        for (;;) {
          const answer = await askUser(`  Agent URL: agents.stroodle.ai/[${slug}]: `, slug);
          try {
            const check = await accountApi.slugAvailable(answer);
            if (check.available) {
              slug = check.slug;
              break;
            }
            slug = check.suggestion ?? slug;
            console.log(`  "${check.slug}" is taken. Try "${slug}" (press Enter) or type another.`);
          } catch {
            slug = answer;
            break;
          }
        }
      }

      try {
        const created = await accountApi.createRuntimeAgent({
          name: agentName,
          slug,
          capabilities: chosen,
        });
        agentId = created.agent_id;
        agentKey = created.api_key;
        slug = created.slug;
        for (const cap of chosen) console.log(`  Registered: ${cap.name}`);
      } catch (err) {
        console.error(`  Could not create the agent: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    // Ask about task processing
    let processingEnabled = true;
    if (!nonInteractive) {
      const answer = await askUser(
        "  Enable automatic task processing? [Y/n] ",
        "y"
      );
      processingEnabled = answer.toLowerCase() !== "n";
    }

    // Save config
    const config: StroodleConfig = {
      agent_id: agentId,
      agent_key: agentKey,
      registry_url: registryUrl,
      capabilities: chosen,
      agent_name: agentName,
      slug,
      daemon: {
        poll_interval_ms: 15_000,
        log_max_lines: 1000,
        mode: "relay",
        port: 0,
      },
      processing: {
        enabled: processingEnabled,
      },
      sharing: {
        kinds: ["heartbeat"],
      },
    };
    await saveConfig(config, projectDir);
    console.log(`  Config saved to .stroodle/config.json`);

    // Add .stroodle/ to .gitignore
    await ensureGitignore(projectDir);

    // Add Stroodle section to CLAUDE.md
    await ensureClaudeMd(projectDir, agentName, chosen);

    console.log(
      `\n  Done. Your agent is configured at ${configDir(projectDir)}`
    );
    if (agentId && slug) console.log(`  Public address: https://agents.stroodle.ai/${slug}`);
    console.log("  Run `stroodle start` to go online.");

    // Global install nudge
    if (process.argv[1]?.includes("npx") || process.env.npm_execpath?.includes("npx")) {
      console.log();
      console.log("  Tip: Install globally for faster access:");
      console.log("    npm i -g stroodle");
      console.log();
      console.log("  Then just: stroodle start, stroodle watch, stroodle status");
    }
    console.log();
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


async function ensureClaudeMd(
  projectDir: string,
  agentName: string,
  capabilities: Capability[]
): Promise<void> {
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const marker = "## Stroodle Agent";
  const capList = capabilities.length > 0
    ? capabilities.map((c) => `- ${c.name}: ${c.description}`).join("\n")
    : "- (none detected, update .stroodle/config.json)";

  const section = `
${marker}

This project is a live A2A agent on the Stroodle network. \`stroodle start\` to go online.
Other agents discover you by capability, send tasks, and get results back automatically.

Capabilities: ${capabilities.map((c) => c.name).join(", ") || "(none yet)"}

Hosting: \`stroodle start\`. That's the deployment. The daemon serves your capabilities
using local tools and MCP servers from .mcp.json. No HTTP server, no cloud deploy, no infra.

Monetization: Stroodle handles discovery and routing. Payments via x402 protocol are on the
roadmap. Your StroodleScore (reputation) grows with every successful task, improving your
ranking in search results and attracting more work.

To add capabilities: configure MCP servers in .mcp.json, then \`stroodle init\` again.
Describe your workflow and output format below to shape how tasks are processed.
`;

  if (existsSync(claudeMdPath)) {
    const content = await readFile(claudeMdPath, "utf-8");
    if (content.includes(marker)) return;
    await writeFile(claudeMdPath, content.trimEnd() + "\n" + section);
    console.log("  Added Stroodle section to CLAUDE.md");
  } else {
    await writeFile(claudeMdPath, `# ${agentName}\n` + section);
    console.log("  Created CLAUDE.md with Stroodle agent context");
  }
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
