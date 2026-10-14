import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SharingConfig {
  kinds: string[];
}

export interface StroodleConfig {
  agent_id: string | null;
  agent_key: string;
  registry_url: string;
  capabilities: Capability[];
  agent_name?: string;
  slug?: string;
  daemon: {
    poll_interval_ms: number;
    log_max_lines: number;
    mode: "relay" | "direct" | "polling";
    port: number;
    public_url?: string;
  };
  processing: {
    enabled: boolean;
  };
  sharing: SharingConfig;
  project_dir?: string;
}

export interface Capability {
  name: string;
  description: string;
  tags: string[];
  price_hint: string | null;
}

const DEFAULT_CONFIG: StroodleConfig = {
  agent_id: null,
  agent_key: "",
  registry_url: "https://api.stroodle.ai",
  capabilities: [],
  daemon: {
    poll_interval_ms: 15_000,
    log_max_lines: 1000,
    mode: "relay",
    port: 0,
  },
  processing: {
    enabled: true,
  },
  sharing: {
    kinds: ["heartbeat"],
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

export function statePath(projectDir?: string): string {
  return join(configDir(projectDir), "state.json");
}

export interface DaemonState {
  mode: "relay" | "direct" | "polling";
  connected: boolean;
  url: string | null;
}

export async function readState(projectDir?: string): Promise<DaemonState | null> {
  try {
    return JSON.parse(await readFile(statePath(projectDir), "utf-8")) as DaemonState;
  } catch {
    return null;
  }
}

export async function loadConfig(
  projectDir?: string
): Promise<StroodleConfig | null> {
  const p = configPath(projectDir);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, "utf-8");
  const parsed = JSON.parse(raw);
  const daemon = { ...DEFAULT_CONFIG.daemon, ...parsed.daemon };
  // configs written before spec 038 used "auto" | "tunnel"
  if (!["relay", "direct", "polling"].includes(daemon.mode)) daemon.mode = "relay";
  return { ...DEFAULT_CONFIG, ...parsed, daemon };
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
  if (!config.agent_key) {
    console.error(
      "No agent key in .stroodle/config.json (configs from before agent keys only hold an account key).\n" +
        "Run `stroodle init` again."
    );
    process.exit(1);
  }
}
