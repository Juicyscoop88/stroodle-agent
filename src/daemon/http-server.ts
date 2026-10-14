import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendLog } from "../lib/log.js";

const MAX_QUEUED = 5;
const MAX_BODY_BYTES = 1_000_000;

export type DirectTaskHandler = (taskId: string, message: string) => Promise<{ result: string; success: boolean }>;

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { message?: { parts?: { kind?: string; type?: string; text?: string }[] } };
}

/**
 * Direct mode: the agent serves A2A itself (JSON-RPC message/send) on a URL the user exposes.
 * Stroodle only indexes it. One task at a time; up to MAX_QUEUED wait, the rest get 503.
 */
export class A2AHttpServer {
  private server: Server | null = null;
  private waiting = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private handler: DirectTaskHandler,
    private projectDir: string
  ) {}

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.route(req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { error: "internal error" });
        });
      });
      this.server.on("error", reject);
      this.server.listen(port, () => {
        const addr = this.server!.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { status: "ok", queued: this.waiting });
    }
    if (req.method === "POST" && (path === "/a2a" || path === "/")) {
      return this.handleRpc(req, res);
    }
    json(res, 404, { error: "not found" });
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rpc: RpcRequest;
    try {
      rpc = JSON.parse(await readBody(req));
    } catch {
      return rpcError(res, null, -32700, "parse error", 400);
    }
    if (rpc.method !== "message/send") {
      return rpcError(res, rpc.id ?? null, -32601, `method not supported: ${rpc.method}`);
    }
    const text = rpc.params?.message?.parts?.find(
      (p) => (p.kind ?? p.type) === "text" && p.text
    )?.text;
    if (!text) return rpcError(res, rpc.id ?? null, -32602, "message must contain a text part");

    if (this.waiting >= MAX_QUEUED) {
      return rpcError(res, rpc.id ?? null, -32000, "agent busy, try again later", 503);
    }

    const taskId = randomUUID();
    this.waiting++;
    const run = this.chain.then(async () => {
      await appendLog(`A2A task received: ${taskId}`, "task", this.projectDir);
      return this.handler(taskId, text);
    });
    this.chain = run.catch(() => {});
    try {
      const { result, success } = await run;
      json(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: {
          kind: "task",
          id: taskId,
          contextId: randomUUID(),
          status: { state: success ? "completed" : "failed" },
          artifacts: [
            { artifactId: `${taskId}-0`, name: "result", parts: [{ kind: "text", text: result }] },
          ],
        },
      });
    } catch (err) {
      rpcError(res, rpc.id ?? null, -32603, err instanceof Error ? err.message : String(err), 500);
    } finally {
      this.waiting--;
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(
  res: ServerResponse,
  id: string | number | null,
  code: number,
  message: string,
  status = 200
): void {
  json(res, status, { jsonrpc: "2.0", id, error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
