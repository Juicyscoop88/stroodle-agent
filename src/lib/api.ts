export class RegistryAPI {
  constructor(
    private baseUrl: string,
    private apiKey: string
  ) {}

  private authHeaders(): Record<string, string> {
    return this.apiKey
      ? { Authorization: `Bearer ${this.apiKey}` }
      : {};
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Registry ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async post<T = unknown>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Registry ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async heartbeat(goingOffline = false) {
    return this.post<{
      pending_tasks: number;
      pending: { task_id: string; message: string }[];
      online: boolean;
    }>("/v1/tasks/heartbeat", { going_offline: goingOffline });
  }

  async inbox(limit = 10) {
    return this.get<{ tasks: InboxTask[] }>("/v1/tasks/inbox", {
      limit: String(limit),
    });
  }

  async completeTask(taskId: string, result: string, success = true) {
    return this.post(`/v1/tasks/${taskId}/complete`, { result, success });
  }

  async registerCapability(cap: {
    name: string;
    description: string;
    tags: string[];
    price_hint: string | null;
  }) {
    return this.post<{ agent_id: string; skill_id: string }>(
      "/v1/agents/register-capability",
      cap
    );
  }

  async getAgent(agentId: string) {
    return this.get(`/v1/agents/${agentId}`);
  }

  async getScore(agentId: string) {
    return this.get<{ score: number }>(`/v1/agents/${agentId}/score`);
  }

  async getRank(agentId: string) {
    return this.get<{ rank: number; of: number; score: number; trend: number | null }>(
      `/v1/agents/${agentId}/rank`
    );
  }

  async getStats() {
    return this.get<{
      agents_online: number;
      tasks_today: number;
      tasks_total: number;
      total_agents: number;
    }>("/v1/stats");
  }

  async submitObservationsA2A(
    agentId: string,
    observations: { kind: string; data: Record<string, unknown> }[],
    sourceAgentId?: string
  ): Promise<{ accepted: number; rejected: number }> {
    const task = {
      id: crypto.randomUUID(),
      message: {
        parts: [{
          type: "data",
          data: {
            skill: "submit-observations",
            agent_id: agentId,
            observations,
            source_agent_id: sourceAgentId ?? null,
          },
        }],
      },
    };
    const url = new URL("/a2a", this.baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify(task),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`A2A observation submit ${res.status}: ${text}`);
    }
    const body = await res.json() as { artifacts?: { parts?: { data?: { accepted: number; rejected: number } }[] }[] };
    const data = body.artifacts?.[0]?.parts?.[0]?.data;
    return data ?? { accepted: 0, rejected: 0 };
  }

  async getDemand() {
    return this.get<{
      top_searched: { query: string; search_count: number; has_results: boolean }[];
      supply_gaps: { query: string; search_count: number; has_results: boolean }[];
    }>("/v1/analytics/demand");
  }
}

export interface InboxTask {
  task_id: string;
  message: string;
  buyer_id?: string;
  created_at?: string;
  status?: { state: string };
}
