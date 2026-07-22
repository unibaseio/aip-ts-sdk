/**
 * A2A HTTP server exposing a single agent, mirroring `aip_sdk/a2a/server.py`
 * and the Go SDK's `server` package: agent-card serving (on GET / as well —
 * the card advertises the root as the web endpoint and the platform
 * health-checks it), JSON-RPC (message/send, tasks/*), /invoke, and gateway
 * polling for private / via-gateway agents, with non-fatal auto-registration.
 */

import * as http from "node:http";
import { randomUUID } from "node:crypto";
import type { Message, Task, TaskState } from "./a2a.js";
import { ERR_INVALID_REQUEST, ERR_METHOD_NOT_FOUND, ERR_PARSE, ERR_TASK_NOT_FOUND, getMessageText, isTerminal, newMessage } from "./a2a.js";
import { PlatformClient } from "./platform.js";
import type { AgentCard, AgentJobOffering, AgentJobResource, CostModel, SkillConfig } from "./types.js";

/**
 * The agent's task handler: receives the task and incoming message, returns
 * the agent's reply messages (appended to history; the task completes unless
 * the handler throws).
 */
export type TaskHandler = (task: Task, message: Message) => Promise<Message[]>;

export interface RegistrationConfig {
  handle: string;
  name: string;
  description?: string;
  userId?: string;
  privyToken?: string;
  /**
   * Token-less registration auth: an EIP-191 signature over `message`; the
   * platform recovers the wallet address from it (see `auth.signMessage`).
   */
  signature?: string;
  message?: string;
  aipEndpoint?: string;
  endpointUrl?: string;
  gatewayUrl?: string;
  viaGateway?: boolean;
  chainId?: number;
  currency?: string;
  skills?: SkillConfig[];
  costModel?: CostModel;
  metadata?: Record<string, unknown>;
  jobOfferings?: AgentJobOffering[];
  jobResources?: AgentJobResource[];
}

const MAX_TASKS = 1000;
const POLL_INTERVAL_MS = 3_000;

/** An A2A-compliant server exposing a single agent. */
export class A2AServer {
  private tasks = new Map<string, Task>();
  private agentId = "";
  private httpServer?: http.Server;
  private stopped = false;

  constructor(
    public readonly agentCard: AgentCard,
    private readonly handler: TaskHandler,
    private readonly host = "0.0.0.0",
    private readonly port = 8000,
    private readonly registrationConfig?: RegistrationConfig,
    private readonly autoRegister = true,
  ) {}

  /** The registered agent ID, if registration has occurred. */
  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Start the server, performing auto-registration and gateway polling as
   * configured. Resolves once the HTTP listener is up; call `stop()` (or
   * abort the signal) to shut down.
   */
  async start(signal?: AbortSignal): Promise<void> {
    const server = http.createServer((req, res) => void this.route(req, res));
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => resolve());
    });
    console.log(`A2A Server starting at http://${this.host}:${this.port}`);
    console.log(`Agent Card: http://${this.host}:${this.port}/.well-known/agent-card.json`);

    signal?.addEventListener("abort", () => void this.stop());

    // Register and poll in the background so a slow or unreachable platform
    // never blocks the HTTP listener; the agent serves locally regardless.
    void (async () => {
      const cfg = this.registrationConfig;
      if (cfg && this.autoRegister) await this.registerWithAIP(cfg);
      // Poll when the agent has no public endpoint (private agents pull their
      // work), and ALSO for viaGateway agents even when an endpoint is set:
      // the platform delivers jobs for via_gateway agents through the gateway
      // job QUEUE (pull), not by pushing to the endpoint.
      if (cfg?.gatewayUrl && (!cfg.endpointUrl || cfg.viaGateway)) {
        await this.gatewayPollingLoop(cfg);
      }
    })();
  }

  /** Run until the (optional) abort signal fires; convenience over start(). */
  async run(signal?: AbortSignal): Promise<void> {
    await this.start(signal);
    await new Promise<void>((resolve) => {
      this.httpServer?.once("close", resolve);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
  }

  // ---------------------------------------------------------------- routing

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS, matching the reference servers.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return void res.writeHead(200).end();

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && (path === "/" || path === "/.well-known/agent-card.json")) {
        return writeJson(res, 200, this.serializeAgentCard());
      }
      if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
        return writeJson(res, 200, { status: "healthy", agent: this.agentCard.name });
      }
      if (req.method === "POST" && (path === "/" || path === "/a2a")) {
        return await this.handleJsonRpc(req, res);
      }
      if (req.method === "POST" && path === "/invoke") {
        return await this.handleInvoke(req, res);
      }
      writeJson(res, 404, { error: `not found: ${req.method} ${path}` });
    } catch (e) {
      writeJson(res, 500, { error: (e as Error).message });
    }
  }

  private serializeAgentCard(): Record<string, unknown> {
    const card = JSON.parse(JSON.stringify(this.agentCard)) as Record<string, unknown>;
    const cfg = this.registrationConfig;
    if (cfg?.endpointUrl) {
      card.endpoint_url = cfg.endpointUrl;
      card.url = cfg.endpointUrl;
    }
    if (!card.url) card.url = `http://${this.host}:${this.port}`;
    return card;
  }

  private async handleJsonRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { jsonrpc?: string; method?: string; params?: unknown; id?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return writeJson(res, 400, rpcError(null, ERR_PARSE, "Invalid JSON"));
    }
    if (body.jsonrpc !== "2.0" || !body.method) {
      return writeJson(res, 400, rpcError(body.id, ERR_INVALID_REQUEST, "Invalid JSON-RPC request"));
    }
    const params = (body.params ?? {}) as Record<string, unknown>;

    try {
      switch (body.method) {
        case "message/send":
          return writeJson(res, 200, rpcResult(body.id, await this.handleMessageSend(params)));
        case "tasks/get":
          return writeJson(res, 200, rpcResult(body.id, this.handleTasksGet(params)));
        case "tasks/list":
          return writeJson(res, 200, rpcResult(body.id, this.handleTasksList(params)));
        case "tasks/cancel":
          return writeJson(res, 200, rpcResult(body.id, this.handleTasksCancel(params)));
        default:
          return writeJson(res, 200, rpcError(body.id, ERR_METHOD_NOT_FOUND, `Method not found: ${body.method}`));
      }
    } catch (e) {
      return writeJson(res, 200, rpcError(body.id, ERR_TASK_NOT_FOUND, (e as Error).message));
    }
  }

  // ------------------------------------------------------------- task logic

  private getOrCreateTask(taskId: string, contextId: string, message: Message): Task {
    const existing = this.tasks.get(taskId);
    if (existing) {
      existing.history.push(message);
      return existing;
    }
    const task: Task = {
      kind: "task",
      id: taskId,
      contextId: contextId || randomUUID(),
      status: { state: "submitted" },
      history: [message],
    };
    this.putTask(taskId, task);
    return task;
  }

  private putTask(id: string, task: Task): void {
    this.tasks.set(id, task);
    while (this.tasks.size > MAX_TASKS) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }

  async handleMessageSend(params: Record<string, unknown>): Promise<Task> {
    const message = params.message as Message | undefined;
    if (!message || !Array.isArray(message.parts)) throw new Error("invalid message");
    const taskId = (params.id as string) || message.taskId || randomUUID();
    const contextId = (params.contextId as string) || message.contextId || "";
    const task = this.getOrCreateTask(taskId, contextId, message);

    task.metadata = { ...(task.metadata ?? {}), last_updated: new Date().toISOString() };
    task.status = { state: "working" };

    try {
      const replies = await this.handler(task, message);
      task.history.push(...replies);
      if (!isTerminal(task.status.state)) task.status = { state: "completed" };
    } catch (e) {
      console.error(`Error in task handler: ${(e as Error).message}`);
      task.status = {
        state: "failed",
        message: newMessage("agent", randomUUID(), `Error: ${(e as Error).message}`),
      };
    }
    this.putTask(taskId, task);
    return task;
  }

  private mustGetTask(params: Record<string, unknown>): Task {
    const taskId = (params.id as string) ?? "";
    const task = this.tasks.get(taskId);
    if (!taskId || !task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private handleTasksGet(params: Record<string, unknown>): Task {
    return this.mustGetTask(params);
  }

  private handleTasksList(params: Record<string, unknown>): { tasks: Task[] } {
    const contextId = (params.contextId as string) ?? "";
    const tasks = [...this.tasks.values()].filter((t) => !contextId || t.contextId === contextId);
    return { tasks };
  }

  private handleTasksCancel(params: Record<string, unknown>): Task {
    const task = this.mustGetTask(params);
    if (isTerminal(task.status.state)) {
      throw new Error(`Task ${task.id} is already in terminal state`);
    }
    task.status = { state: "canceled" satisfies TaskState };
    return task;
  }

  private async handleInvoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { message?: string; context?: Record<string, unknown> };
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return writeJson(res, 500, { error: (e as Error).message, success: false });
    }
    const runId = (body.context?.run_id as string) || randomUUID();
    const agentId =
      this.agentId || (this.registrationConfig ? `erc8004:${this.registrationConfig.handle}` : "");

    const msg = newMessage("user", randomUUID(), body.message ?? "");
    msg.metadata = body.context;
    try {
      const task = await this.handleMessageSend({ id: runId, message: msg });
      writeJson(res, 200, {
        run_id: runId,
        agent_id: agentId,
        success: task.status.state === "completed",
        content: extractAgentText(task),
        data: task.metadata,
      });
    } catch (e) {
      writeJson(res, 500, { error: (e as Error).message, success: false });
    }
  }

  // ----------------------------------------------------------- registration

  private async registerWithAIP(cfg: RegistrationConfig): Promise<void> {
    const endpoint = cfg.aipEndpoint || "";
    const client = new PlatformClient(endpoint);
    console.log(
      `Registering agent with AIP platform at ${client.baseUrl} (handle erc8004:${cfg.handle})`,
    );
    if (cfg.userId) console.log(`  User ID: ${cfg.userId}`);
    try {
      const result = await client.registerAgent(
        {
          name: cfg.name,
          handle: cfg.handle,
          description: cfg.description,
          endpointUrl: cfg.endpointUrl,
          skills: cfg.skills,
          costModel: cfg.costModel ?? { baseCallFee: 0.001 },
          currency: cfg.currency ?? "USD",
          metadata: cfg.metadata,
          jobOfferings: cfg.jobOfferings,
          jobResources: cfg.jobResources,
          chainId: cfg.chainId || 97,
          signature: cfg.signature,
          message: cfg.message,
        },
        { userId: cfg.userId, privyToken: cfg.privyToken },
      );
      this.agentId = (result.agent_id as string) || `erc8004:${cfg.handle}`;
      console.log(`Agent registered successfully: ${this.agentId}`);
    } catch (e) {
      // Non-fatal: the service still runs without registration.
      console.warn(
        `AIP registration failed (agent will run without registration): ${(e as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------- polling

  private async gatewayPollingLoop(cfg: RegistrationConfig): Promise<void> {
    const gatewayUrl = (cfg.gatewayUrl ?? "").replace(/\/+$/, "");
    // The platform tracks assignments by the chain-scoped agent_id returned
    // from registration — poll with the same ID, falling back to the handle.
    const useJobQueue = (cfg.jobOfferings?.length ?? 0) > 0 || !!cfg.viaGateway;
    const pollAgent = useJobQueue ? this.agentId || cfg.handle : cfg.handle;
    const pollEndpoint = `${gatewayUrl}/gateway/${useJobQueue ? "jobs" : "tasks"}/poll`;
    const completeEndpoint = `${gatewayUrl}/gateway/${useJobQueue ? "jobs" : "tasks"}/complete`;
    console.log(
      `Starting Gateway ${useJobQueue ? "JOB" : "TASK"}-QUEUE polling loop for agent ${pollAgent}`,
    );

    while (!this.stopped) {
      try {
        const q = new URLSearchParams({ agent: pollAgent, timeout: "5.0" });
        const resp = await fetch(`${pollEndpoint}?${q}`, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const payload = (await resp.json()) as Record<string, unknown>;
        const assignmentId = (payload.task_id as string) || (payload.job_id as string) || "";
        if (!assignmentId) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        console.log(`Received assignment ${assignmentId} from Gateway (job_queue=${useJobQueue})`);
        if (useJobQueue) {
          await this.processGatewayJob(assignmentId, payload, completeEndpoint);
        } else {
          await this.processGatewayTask(assignmentId, payload, completeEndpoint);
        }
      } catch {
        await sleep(POLL_INTERVAL_MS);
      }
    }
    console.log("Gateway polling loop stopped");
  }

  private async processGatewayJob(
    jobId: string,
    jobData: Record<string, unknown>,
    completeEndpoint: string,
  ): Promise<void> {
    const jobInput = (jobData.job_input as string) ?? "";
    const body: Record<string, unknown> = {
      job_id: jobId,
      agent_id: jobData.agent_id,
      status: "completed",
    };
    try {
      const task = await this.handleMessageSend({
        message: newMessage("user", randomUUID(), jobInput),
      });
      body.result = { response: extractAgentText(task), task };
    } catch (e) {
      body.status = "failed";
      body.error = (e as Error).message;
      body.result = {};
    }
    await postJson(completeEndpoint, body);
    console.log(`Job ${jobId} completed and result submitted to job queue`);
  }

  private async processGatewayTask(
    taskId: string,
    taskData: Record<string, unknown>,
    completeEndpoint: string,
  ): Promise<void> {
    const payload = (taskData.payload ?? {}) as Record<string, unknown>;
    const params = (payload.params ?? {}) as Record<string, unknown>;
    const method = (payload.method as string) ?? "";

    const body: Record<string, unknown> = { task_id: taskId, status: "completed" };
    try {
      switch (method) {
        case "tasks/get":
          body.result = this.handleTasksGet(params);
          break;
        case "tasks/cancel":
          body.result = this.handleTasksCancel(params);
          break;
        default:
          body.result = await this.handleMessageSend(params);
      }
    } catch (e) {
      body.status = "failed";
      body.error = (e as Error).message;
      delete body.result;
    }
    await postJson(completeEndpoint, body);
    console.log(`Task ${taskId} completed and result submitted`);
  }
}

// --------------------------------------------------------------- utilities

function writeJson(res: http.ServerResponse, status: number, v: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(v));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Latest agent-role text in the task history. */
export function extractAgentText(task: Task): string {
  for (let i = task.history.length - 1; i >= 0; i--) {
    const msg = task.history[i];
    if (msg?.role === "agent") {
      const text = getMessageText(msg);
      if (text) return text;
    }
  }
  return "";
}

async function postJson(url: string, body: unknown): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    resp.body?.cancel();
  } catch (e) {
    console.error(`Failed to submit result: ${(e as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
