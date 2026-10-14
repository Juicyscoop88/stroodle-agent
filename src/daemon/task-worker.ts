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
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  // Tasks come from other agents, so nothing is auto-approved: "dontAsk" denies every tool
  // that the project's own .claude/settings*.json (allow list) and .mcp.json do not permit.
  const stream = query({
    prompt,
    options: {
      cwd,
      permissionMode: "dontAsk",
      settingSources: ["project", "local"],
    },
  });
  for await (const msg of stream) {
    if (msg.type !== "result") continue;
    if (msg.subtype === "success") return msg.result || "(no result)";
    throw new Error(`Task failed: ${msg.subtype}`);
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
