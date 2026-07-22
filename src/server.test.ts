import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exposeAsA2A } from "./wrappers.js";
import type { A2AServer } from "./server.js";

const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PORT = 8961;
const GW_PORT = 8962;
const BASE = `http://127.0.0.1:${PORT}`;

// A stub gateway: serves one job from the queue, records the completion.
let gatewayServer: http.Server;
let served = false;
const completions: unknown[] = [];

function startStubGateway(): Promise<void> {
  gatewayServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/gateway/jobs/poll") {
      res.setHeader("Content-Type", "application/json");
      if (served) return void res.end("{}");
      served = true;
      return void res.end(
        JSON.stringify({ job_id: "job-1", agent_id: "erc8004:ts-e2e", job_input: "ping" }),
      );
    }
    if (req.method === "POST" && url.pathname === "/gateway/jobs/complete") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        completions.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.end("{}");
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => gatewayServer.listen(GW_PORT, "127.0.0.1", resolve));
}

let server: A2AServer;

beforeAll(async () => {
  await startStubGateway();
  process.env.UNIBASE_WALLET_PRIVATE_KEY = ANVIL0;
  server = exposeAsA2A(
    {
      name: "TS E2E Agent",
      handle: "ts-e2e",
      description: "test agent",
      host: "127.0.0.1",
      port: PORT,
      aipEndpoint: "http://127.0.0.1:9", // unreachable — registration is non-fatal
      gatewayUrl: `http://127.0.0.1:${GW_PORT}`,
      viaGateway: true,
      jobOfferings: [
        { id: "echo", name: "echo", type: "JOB", price: 0, active: true },
      ],
    },
    (input) => `Echo: ${input}`,
  );
  await server.start();
});

afterAll(async () => {
  delete process.env.UNIBASE_WALLET_PRIVATE_KEY;
  await server.stop();
  gatewayServer.close();
});

describe("A2AServer", () => {
  it("serves the agent card on GET / and the well-known path", async () => {
    for (const path of ["/", "/.well-known/agent-card.json"]) {
      const resp = await fetch(BASE + path);
      expect(resp.status).toBe(200);
      const card = (await resp.json()) as Record<string, unknown>;
      expect(card.name).toBe("TS E2E Agent");
      // Base URL, not the card path (cross-language card contract).
      const services = card.services as { name: string; endpoint: string }[];
      expect(services[0]?.endpoint).not.toContain("well-known");
    }
  });

  it("answers health checks", async () => {
    const resp = await fetch(`${BASE}/healthz`);
    expect(((await resp.json()) as { status: string }).status).toBe("healthy");
  });

  it("handles JSON-RPC message/send and tasks/get", async () => {
    const send = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          id: "task-1",
          message: {
            kind: "message",
            messageId: "m1",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
      }),
    });
    const body = (await send.json()) as { result: { status: { state: string }; history: unknown[] } };
    expect(body.result.status.state).toBe("completed");

    const get = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "task-1" } }),
    });
    const got = (await get.json()) as { result: { id: string } };
    expect(got.result.id).toBe("task-1");
  });

  it("handles /invoke with plain text and returns the handler output", async () => {
    const resp = await fetch(`${BASE}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello world" }),
    });
    const body = (await resp.json()) as { success: boolean; content: string; agent_id: string };
    expect(body.success).toBe(true);
    expect(body.content).toBe("Echo: hello world");
    expect(body.agent_id).toBe("erc8004:ts-e2e");
  });

  it("polls the gateway job queue and submits the result", async () => {
    // Wait for the polling loop to pick up and complete the stub job.
    for (let i = 0; i < 50 && completions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(completions.length).toBe(1);
    const done = completions[0] as {
      job_id: string;
      status: string;
      result: { response: string };
    };
    expect(done.job_id).toBe("job-1");
    expect(done.status).toBe("completed");
    expect(done.result.response).toBe("Echo: ping");
  });
});
