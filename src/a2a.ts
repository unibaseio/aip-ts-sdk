/**
 * A2A protocol wire types (v0.3.x line — camelCase JSON with `kind`
 * discriminators, `role: "user"`, `state: "completed"`), matching the official
 * a2a-js / a2a-go SDKs and the cross-language contract fixtures. Plus a small
 * outbound client for calling other agents.
 */

import { randomUUID } from "node:crypto";

export type Role = "user" | "agent";

export interface TextPart {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | DataPart | { kind: string; [k: string]: unknown };

export interface Message {
  kind: "message";
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  parts: Part[];
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface Task {
  kind?: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  history: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

// JSON-RPC error codes (A2A spec).
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INTERNAL = -32603;
export const ERR_TASK_NOT_FOUND = -32001;

/** Create a user/agent text message. */
export function newMessage(role: Role, messageId: string, text: string): Message {
  return { kind: "message", messageId, role, parts: [{ kind: "text", text }] };
}

/** Extract the first text part of a message. */
export function getMessageText(message: Message | undefined): string {
  if (!message) return "";
  for (const part of message.parts) {
    if (part.kind === "text" && typeof (part as TextPart).text === "string") {
      return (part as TextPart).text;
    }
  }
  return "";
}

export function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

/** Minimal outbound A2A client: send a message via JSON-RPC message/send. */
export class A2AClient {
  constructor(private readonly timeoutMs = 60_000) {}

  /** POST a message/send to the agent's base URL and return the task. */
  async sendTask(baseUrl: string, message: Message, taskId = ""): Promise<Task> {
    const params: Record<string, unknown> = { message };
    if (taskId) params.id = taskId;
    const resp = await fetch(baseUrl.replace(/\/+$/, "") + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "message/send", params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) throw new Error(`A2A request failed: HTTP ${resp.status}`);
    const body = (await resp.json()) as { result?: Task; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "A2A error");
    if (!body.result) throw new Error("A2A response missing result");
    return body.result;
  }

  /** Fetch an agent card from its base URL. */
  async fetchAgentCard(baseUrl: string): Promise<Record<string, unknown>> {
    const resp = await fetch(
      baseUrl.replace(/\/+$/, "") + "/.well-known/agent-card.json",
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!resp.ok) throw new Error(`agent card fetch failed: HTTP ${resp.status}`);
    return (await resp.json()) as Record<string, unknown>;
  }
}
