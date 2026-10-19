import { z } from "zod";
import type { StroodleConfig } from "../lib/config.js";

// Built-in tools that let the agent's LLM find and call other agents (spec 046). They use the
// agent's own key, so nothing in the project directory can reach the account key, and they are
// the only network tools granted beyond what the project itself allows.

const ASK_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

type SearchResult = {
  name: string;
  description: string;
  primary_url: string;
  source: string;
  online: boolean | null;
  score: number;
};

type TaskResult = {
  status?: { state?: string };
  artifacts?: { parts?: { text?: string }[] }[];
  id?: string;
};

function slugFromUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts[parts.length - 1] === "a2a") parts.pop();
    return parts.length === 1 ? parts[0] : null;
  } catch {
    return null;
  }
}

function resultText(task: TaskResult): string {
  const text = (task.artifacts ?? [])
    .flatMap((a) => a.parts ?? [])
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n");
  return text || `(no result, state: ${task.status?.state ?? "unknown"})`;
}

async function rpc(
  config: StroodleConfig,
  slug: string,
  method: string,
  params: Record<string, unknown>,
  depth: number
): Promise<{ result?: TaskResult; error?: { message: string } }> {
  const res = await fetch(new URL(`/${slug}/a2a`, config.registry_url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.agent_key}`,
      "X-Stroodle-Depth": String(depth),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(40_000),
  });
  return (await res.json()) as { result?: TaskResult; error?: { message: string } };
}

export async function findAgents(config: StroodleConfig, query: string, limit = 5): Promise<string> {
  const url = new URL("/v1/search", config.registry_url);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 10)));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.agent_key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return `Search failed (${res.status})`;
  const data = (await res.json()) as { results: SearchResult[] };
  const lines = data.results
    .map((r) => ({ r, slug: r.source === "runtime" ? slugFromUrl(r.primary_url) : null }))
    .filter(({ slug }) => slug !== config.slug)
    .map(({ r, slug }) =>
      [
        `- ${r.name}`,
        slug ? ` (slug: ${slug}, callable${r.online === false ? ", offline" : ""})` : " (listed only, not callable here)",
        `: ${r.description.slice(0, 160)}`,
      ].join("")
    );
  return lines.length ? lines.join("\n") : "No agents found.";
}

export async function askAgent(
  config: StroodleConfig,
  slug: string,
  message: string,
  depth: number
): Promise<string> {
  const params = {
    message: { role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: message }] },
  };
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  let reply = await rpc(config, slug, "message/send", params, depth);
  if (reply.error) return `Call failed: ${reply.error.message}`;
  let task = reply.result;
  while (task && ["submitted", "working"].includes(task.status?.state ?? "") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    reply = await rpc(config, slug, "tasks/get", { id: task.id }, depth);
    if (reply.error) return `Call failed: ${reply.error.message}`;
    task = reply.result;
  }
  if (!task) return "Call failed: empty response";
  const state = task.status?.state;
  if (state === "failed" || state === "canceled") return `The agent could not complete the task (${state}).`;
  if (state !== "completed") return "The agent did not answer in time.";
  return resultText(task);
}

/** In-process MCP server handed to the claude-agent-sdk for one task. */
export async function createPeerServer(config: StroodleConfig, taskDepth: number) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  return createSdkMcpServer({
    name: "stroodle",
    version: "0.1.0",
    tools: [
      tool(
        "find_agents",
        "Search the Stroodle network for other agents that can do something you cannot. Returns slugs you can pass to ask_agent.",
        { query: z.string().describe("What you need, in plain words"), limit: z.number().optional() },
        async (args) => text(await findAgents(config, args.query, args.limit))
      ),
      tool(
        "ask_agent",
        "Send a task to another agent by slug and wait for its answer. Use it for parts of the job another agent does better.",
        { slug: z.string().describe("Agent slug from find_agents"), message: z.string().describe("The task, self-contained") },
        async (args) => text(await askAgent(config, args.slug, args.message, taskDepth))
      ),
    ],
  });
}

export const PEER_TOOL_NAMES = ["mcp__stroodle__find_agents", "mcp__stroodle__ask_agent"];
