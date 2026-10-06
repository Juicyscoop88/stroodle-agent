import { Command } from "commander";
import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { loadConfig, requireConfig, pidPath } from "../../lib/config.js";
import { RegistryAPI } from "../../lib/api.js";
import { readLogs } from "../../lib/log.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

interface DashboardState {
  daemonAlive: boolean;
  daemonPid: number | null;
  uptime: string;
  score: number | null;
  rank: number | null;
  rankOf: number | null;
  trend: number | null;
  capabilities: string[];
  tasks: TaskEntry[];
  agentsOnline: number;
  tasksToday: number;
  demandHint: string;
  pendingCount: number;
  startedAt: number;
}

interface TaskEntry {
  message: string;
  state: "working" | "completed" | "failed";
  timeAgo: string;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

function parseTasksFromLogs(logContent: string): TaskEntry[] {
  const lines = logContent.split("\n").filter((l) => l.includes("[TASK ]"));
  const tasks: TaskEntry[] = [];
  const now = Date.now();

  for (const line of lines.slice(-10)) {
    const timeMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    const msgMatch = line.match(/\[TASK \] New task [^:]+: "(.+)"$/);
    if (!msgMatch) continue;

    let timeAgo = "";
    if (timeMatch) {
      const ts = new Date(timeMatch[1] + "Z").getTime();
      const diffMs = now - ts;
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) timeAgo = "just now";
      else if (diffMin < 60) timeAgo = `${diffMin}m ago`;
      else timeAgo = `${Math.floor(diffMin / 60)}h ago`;
    }

    tasks.push({
      message: msgMatch[1].length > 50 ? msgMatch[1].slice(0, 47) + "..." : msgMatch[1],
      state: "completed",
      timeAgo,
    });
  }

  return tasks.reverse();
}

function HLine({ width, left, right }: { width: number; left?: string; right?: string }) {
  const l = left ?? "├";
  const r = right ?? "┤";
  return <Text>  {l}{"─".repeat(width - 2)}{r}</Text>;
}

function Dashboard({ config, api }: { config: { agent_id: string | null; capabilities: { name: string }[]; registry_url: string; api_key: string }; api: RegistryAPI }) {
  const { exit } = useApp();
  const W = 58;

  const [state, setState] = useState<DashboardState>({
    daemonAlive: false,
    daemonPid: null,
    uptime: "0s",
    score: null,
    rank: null,
    rankOf: null,
    trend: null,
    capabilities: config.capabilities.map((c) => c.name),
    tasks: [],
    agentsOnline: 0,
    tasksToday: 0,
    demandHint: "",
    pendingCount: 0,
    startedAt: Date.now(),
  });

  useInput((input) => {
    if (input === "q") exit();
  });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;

      const projectDir = process.cwd();

      // Check daemon
      let daemonPid: number | null = null;
      let daemonAlive = false;
      const p = pidPath(projectDir);
      if (existsSync(p)) {
        try {
          const content = await readFile(p, "utf-8");
          daemonPid = parseInt(content.trim(), 10) || null;
          if (daemonPid) {
            try {
              process.kill(daemonPid, 0);
              daemonAlive = true;
            } catch {}
          }
        } catch {}
      }

      // Rank
      let score: number | null = null;
      let rank: number | null = null;
      let rankOf: number | null = null;
      let trend: number | null = null;
      if (config.agent_id) {
        try {
          const r = await api.getRank(config.agent_id);
          score = r.score;
          rank = r.rank;
          rankOf = r.of;
          trend = r.trend;
        } catch {
          try {
            const s = await api.getScore(config.agent_id);
            score = s.score;
          } catch {}
        }
      }

      // Stats
      let agentsOnline = 0;
      let tasksToday = 0;
      try {
        const stats = await api.getStats();
        agentsOnline = stats.agents_online;
        tasksToday = stats.tasks_today;
      } catch {}

      // Demand
      let demandHint = "";
      try {
        const demand = await api.getDemand();
        const gaps = demand.supply_gaps ?? [];
        if (gaps.length > 0) {
          demandHint = `"${gaps[0].query}" (${gaps[0].search_count} unmet)`;
        }
      } catch {}

      // Pending
      let pendingCount = 0;
      try {
        const hb = await api.heartbeat();
        pendingCount = hb.pending_tasks;
      } catch {}

      // Tasks from logs
      let tasks: TaskEntry[] = [];
      try {
        const logs = await readLogs(100, projectDir);
        tasks = parseTasksFromLogs(logs);
      } catch {}

      // Mark first task as working if pending
      if (pendingCount > 0 && tasks.length > 0) {
        tasks[0] = { ...tasks[0], state: "working", timeAgo: "working..." };
      }

      if (!cancelled) {
        setState((prev) => ({
          ...prev,
          daemonAlive,
          daemonPid,
          uptime: formatUptime(Date.now() - prev.startedAt),
          score,
          rank,
          rankOf,
          trend,
          tasks,
          agentsOnline,
          tasksToday,
          demandHint,
          pendingCount,
        }));
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Update uptime every second
  useEffect(() => {
    const interval = setInterval(() => {
      setState((prev) => ({
        ...prev,
        uptime: formatUptime(Date.now() - prev.startedAt),
      }));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));
  const inner = W - 4;

  const statusStr = state.daemonAlive ? "online" : "offline";
  const scoreStr = state.score !== null ? state.score.toFixed(2) : "---";
  const trendChar = state.trend !== null ? (state.trend >= 0 ? " ▲" : " ▼") : "";
  const rankStr = state.rank !== null ? `#${state.rank}` : "---";

  const headerLeft = `status: ${statusStr}`;
  const headerRight = `score: ${scoreStr}${trendChar}        uptime: ${state.uptime}`;
  const headerLine = pad(`${headerLeft}         ${headerRight}`, inner);

  const capsLine = pad(`capabilities: ${state.capabilities.join(", ") || "none"}`, inner);

  return (
    <Box flexDirection="column">
      <Text>  {"┌─ stroodle agent ─" + "─".repeat(W - 20) + "┐"}</Text>
      <Text>  {"│  "}{pad(headerLine, inner)}{"  │"}</Text>
      <Text>  {"│  "}{pad(capsLine, inner)}{"  │"}</Text>
      <HLine width={W} />

      <Text>  {"│  "}{pad("INCOMING TASKS", inner)}{"  │"}</Text>
      {state.tasks.length === 0 ? (
        <Text>  {"│  "}{pad("No tasks yet.", inner)}{"  │"}</Text>
      ) : (
        state.tasks.slice(0, 5).map((task, i) => {
          const icon = task.state === "working" ? "●" : task.state === "completed" ? "✓" : "✗";
          const line = `${icon} ${task.message}`;
          const full = pad(line, inner - task.timeAgo.length - 2) + task.timeAgo;
          return <Text key={i}>  {"│  "}{pad(full, inner)}{"  │"}</Text>;
        })
      )}
      <HLine width={W} />

      <Text>  {"│  "}{pad("NETWORK", inner)}{"  │"}</Text>
      <Text>  {"│  "}{pad(`agents online: ${state.agentsOnline}    tasks today: ${state.tasksToday.toLocaleString()}`, inner)}{"  │"}</Text>
      <Text>  {"│  "}{pad(`your rank: ${rankStr}        ${state.demandHint ? "demand: " + state.demandHint : ""}`, inner)}{"  │"}</Text>
      <HLine width={W} />

      <Text>  {"│  "}{pad("q quit", inner)}{"  │"}</Text>
      <Text>  {"└" + "─".repeat(W - 2) + "┘"}</Text>
    </Box>
  );
}

export const watchCommand = new Command("watch")
  .description("Live dashboard showing agent status, tasks, and network stats")
  .action(async () => {
    const projectDir = process.cwd();
    const config = await loadConfig(projectDir);
    requireConfig(config);

    const api = new RegistryAPI(config.registry_url, config.api_key);

    render(<Dashboard config={config} api={api} />);
  });
