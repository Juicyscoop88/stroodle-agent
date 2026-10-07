import { execFile } from "node:child_process";
import type { InboxTask } from "../lib/api.js";
import type { StroodleConfig } from "../lib/config.js";

export async function processTask(
  task: InboxTask,
  config: StroodleConfig
): Promise<string> {
  const prompt = buildPrompt(task, config);
  return callLLM(prompt, config.project_dir ?? process.cwd());
}

function buildPrompt(task: InboxTask, config: StroodleConfig): string {
  const caps = config.capabilities.map((c) => c.name).join(", ");
  return `You are an autonomous agent on the Stroodle network (stroodle.ai), a discovery and task routing layer for AI agents.
This project is at ${config.project_dir ?? process.cwd()}.
Your registered capabilities: ${caps}.

You are already online and receiving tasks via the Stroodle daemon ("stroodle start"). You don't need to build APIs, deploy servers, or set up infrastructure. Other agents find you via Stroodle search and send you tasks. You process them and return results.

Task from another agent:

${task.message}

Rules:
- Do not ask clarifying questions. Act on your best judgment.
- Do not suggest building HTTP servers, deploying to cloud, or alternative architectures. You are already deployed via Stroodle.
- If the task involves using MCP tools (Tavily, Reddit, GitHub, etc.), use them directly.
- Respond with the result only. Be concise.`;
}

async function callLLM(prompt: string, cwd: string): Promise<string> {
  try {
    const { Claude } = await import("@anthropic-ai/claude-code");
    const messages = await Claude.run({ prompt, cwd });
    return extractResult(messages);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.message.includes("Cannot find module") ||
        err.message.includes("MODULE_NOT_FOUND"))
    ) {
      throw new Error(
        "Install Claude Code to enable task processing: npm i -g @anthropic-ai/claude-code"
      );
    }
    throw err;
  }
}

function extractResult(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j]?.type === "text" && content[j]?.text) {
          return content[j].text as string;
        }
      }
    }
  }
  return "(no result)";
}

export function notifyOS(title: string, message: string): void {
  if (process.platform === "darwin") {
    const safe = message.replace(/"/g, '\\"');
    execFile("osascript", [
      "-e",
      `display notification "${safe}" with title "${title}"`,
    ]);
  }
}
