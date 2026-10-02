import { appendFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { logPath } from "./config.js";

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export async function appendLog(
  message: string,
  level: "info" | "error" | "task" = "info",
  projectDir?: string
): Promise<void> {
  const line = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] ${message}\n`;
  const p = logPath(projectDir);
  try {
    await appendFile(p, line);
  } catch {
    // log dir might not exist yet during early startup
  }
}

export async function readLogs(
  lines = 50,
  projectDir?: string
): Promise<string> {
  const p = logPath(projectDir);
  if (!existsSync(p)) return "No logs yet.";
  const content = await readFile(p, "utf-8");
  const allLines = content.trim().split("\n");
  return allLines.slice(-lines).join("\n");
}
