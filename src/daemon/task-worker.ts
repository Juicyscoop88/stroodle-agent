import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InboxTask } from "../lib/api.js";
import type { StroodleConfig } from "../lib/config.js";
import { createPeerServer, PEER_TOOL_NAMES } from "./peer-tools.js";

export async function processTask(
  task: InboxTask,
  config: StroodleConfig
): Promise<string> {
  const prompt = buildPrompt(task, config);
  return callLLM(prompt, config.project_dir ?? process.cwd(), config, task.depth ?? 0);
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
- If part of the job is outside your capabilities, use find_agents and ask_agent to get it done by another agent. Do not call an agent for something you can do yourself.
- Respond with the result only. Be concise.`;
}

const num = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Limits of one task. A task comes from another agent, so it must not be able to spend without bound: the number of
 * turns is capped by default, a budget in USD is opt-in (STROODLE_MAX_BUDGET_USD), the model can be pinned
 * (STROODLE_MODEL, e.g. an inference profile when running on Bedrock).
 */
function taskLimits() {
  return {
    maxTurns: num(process.env.STROODLE_MAX_TURNS) ?? 40,
    maxBudgetUsd: num(process.env.STROODLE_MAX_BUDGET_USD),
    model: process.env.STROODLE_MODEL || undefined,
  };
}

/** What the LLM cost, one line per task in .stroodle/spend.jsonl, so an owner (or the lab driver) can cap a day. */
async function recordSpend(cwd: string, usd: number, taskDepth: number): Promise<void> {
  try {
    const dir = join(cwd, ".stroodle");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "spend.jsonl"), JSON.stringify({ ts: new Date().toISOString(), usd, depth: taskDepth }) + "\n");
  } catch {
    /* accounting must never fail a task */
  }
}

async function callLLM(prompt: string, cwd: string, config: StroodleConfig, depth: number): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  // Tasks come from other agents, so nothing is auto-approved: "dontAsk" denies every tool
  // that the project's own .claude/settings*.json (allow list) and .mcp.json do not permit.
  const stream = query({
    prompt,
    options: {
      cwd,
      permissionMode: "dontAsk",
      settingSources: ["project", "local"],
      // Peer tools use this agent's own key (spec 046); nothing else is auto-approved.
      mcpServers: { stroodle: await createPeerServer(config, depth) },
      allowedTools: PEER_TOOL_NAMES,
      ...taskLimits(),
    },
  });
  for await (const msg of stream) {
    if (msg.type !== "result") continue;
    await recordSpend(cwd, msg.total_cost_usd ?? 0, depth);
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
