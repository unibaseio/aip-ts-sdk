/**
 * Client for the AIP platform, mirroring `aip_sdk/platform/client.py` and the
 * Go SDK's `platform` package: health, agent registration, and run/runStream.
 */

import type { AgentConfig } from "./types.js";
import { toRegistrationMap } from "./types.js";

/** Base URL from AIP_ENDPOINT, or the public platform default. */
export function defaultBaseUrl(): string {
  return process.env.AIP_ENDPOINT || "https://api.aip.unibase.com";
}

export interface RunOptions {
  agent?: string;
  domainHint?: string;
  userId?: string;
  /** Stream timeout in milliseconds (default 300_000). */
  timeoutMs?: number;
}

export interface EventData {
  eventType: string;
  payload: Record<string, unknown>;
  timestamp?: string;
  runId?: string;
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface RunResult {
  runId: string;
  status: RunStatus;
  result: Record<string, unknown> | null;
  events: EventData[];
  error: string;
  payments: Record<string, unknown>[];
}

export interface RegisterAgentOptions {
  /** User wallet address for the token-less path. */
  userId?: string;
  /** Privy Bearer token — when set, user_id is omitted from the body. */
  privyToken?: string;
}

export class RegistrationError extends Error {
  constructor(
    message: string,
    public readonly handle?: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

export class PlatformClient {
  readonly baseUrl: string;

  constructor(baseUrl = "") {
    this.baseUrl = (baseUrl || defaultBaseUrl()).replace(/\/+$/, "");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`);
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Register an agent with the AIP platform.
   *
   * Auth methods (mirrors the Python/Go SDKs):
   * - Bearer token: `Authorization: Bearer {privyToken}` — user_id is omitted
   *   from the body; the platform resolves the user from the token.
   * - Wallet signature: set `signature`/`message` on the AgentConfig; the
   *   platform recovers the wallet from the EIP-191 signature.
   */
  async registerAgent(
    cfg: AgentConfig,
    opts: RegisterAgentOptions = {},
  ): Promise<Record<string, unknown>> {
    const regData = toRegistrationMap(cfg);
    if (opts.userId && !opts.privyToken) regData.user_id = opts.userId;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.privyToken) headers.Authorization = `Bearer ${opts.privyToken}`;

    const resp = await fetch(`${this.baseUrl}/agents/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(regData),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new RegistrationError(
        `Failed to register agent: HTTP ${resp.status}: ${body}`,
        String(regData.handle ?? ""),
      );
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * Stream run events (SSE over POST /runs/stream), yielding parsed events.
   */
  async *runStream(objective: string, opts: RunOptions = {}): AsyncGenerator<EventData> {
    const payload: Record<string, unknown> = { objective };
    if (opts.agent) payload.agent = opts.agent;
    if (opts.domainHint) payload.domain_hint = opts.domainHint;
    if (opts.userId) payload.user_id = opts.userId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 300_000);
    try {
      const resp = await fetch(`${this.baseUrl}/runs/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Task execution failed: HTTP ${resp.status}: ${body}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            yield eventFromMap(JSON.parse(raw) as Record<string, unknown>);
          } catch {
            // skip malformed events, matching the reference SDKs
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Execute a task and return the aggregated final result. */
  async run(objective: string, opts: RunOptions = {}): Promise<RunResult> {
    const events: EventData[] = [];
    const payments: Record<string, unknown>[] = [];
    let result: Record<string, unknown> | null = null;
    let runId = "";
    let errMsg = "";

    try {
      for await (const e of this.runStream(objective, opts)) {
        events.push(e);
        if (!runId && e.runId) runId = e.runId;
        const type = e.eventType.toLowerCase();
        if (type.includes("payment")) {
          payments.push({ event_type: e.eventType, timestamp: e.timestamp, ...e.payload });
        }
        if (type.includes("completed") || type === "run_completed") {
          result = e.payload;
        } else if (type.includes("error") || type.includes("failed")) {
          errMsg = String(e.payload.message ?? e.payload.error ?? JSON.stringify(e.payload));
        }
      }
    } catch (e) {
      errMsg = (e as Error).message;
    }

    return {
      runId,
      status: errMsg ? "failed" : "completed",
      result,
      events,
      error: errMsg,
      payments,
    };
  }
}

function eventFromMap(data: Record<string, unknown>): EventData {
  const getStr = (...keys: string[]): string => {
    for (const k of keys) {
      const v = data[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const payload =
    data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
      ? (data.payload as Record<string, unknown>)
      : data;
  return {
    eventType: getStr("eventType", "type") || "unknown",
    payload,
    timestamp: getStr("timestamp"),
    runId: getStr("runId"),
  };
}
