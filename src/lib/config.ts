import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface StroodleConfig {
  agent_id: string | null;
  api_key: string;
  registry_url: string;
  capabilities: Capability[];
  daemon: {
    poll_interval_ms: number;
    log_max_lines: number;
  };
}

export interface Capability {
  name: string;
  description: string;
  tags: string[];
  price_hint: string | null;
}

const DEFAULT_CONFIG: StroodleConfig = {
  agent_id: null,
  api_key: "",
  registry_url: "https://api.stroodle.ai",
  capabilities: [],
  daemon: {
    poll_interval_ms: 15_000,
    log_max_lines: 1000,
  },
};

export function configDir(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), ".stroodle");
}

export function configPath(projectDir?: string): string {
  return join(configDir(projectDir), "config.json");
}

export function pidPath(projectDir?: string): string {
  return join(configDir(projectDir), "daemon.pid");
}

export function logPath(projectDir?: string): string {
  return join(configDir(projectDir), "daemon.log");
}

export async function loadConfig(
  projectDir?: string
): Promise<StroodleConfig | null> {
  const p = configPath(projectDir);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export async function saveConfig(
  config: StroodleConfig,
  projectDir?: string
): Promise<void> {
  const dir = configDir(projectDir);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(configPath(projectDir), JSON.stringify(config, null, 2) + "\n");
}

export function requireConfig(
  config: StroodleConfig | null
): asserts config is StroodleConfig {
  if (!config) {
    console.error(
      "No .stroodle/config.json found. Run `stroodle init` first."
    );
    process.exit(1);
  }
  if (!config.api_key) {
    console.error("No API key configured. Run `stroodle init` first.");
    process.exit(1);
  }
}
