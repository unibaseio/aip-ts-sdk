import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exposeAsA2A } from "./wrappers.js";
import type { A2AServer } from "./server.js";

const AGENT_PORT = 8971;
const GW_PORT = 8972;
const PLATFORM_PORT = 8973;

const registeredChains = new Set<number>();
const polledAgents = new Set<string>();

let platform: http.Server;
let gateway: http.Server;
let server: A2AServer;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

beforeAll(async () => {
  // Fake platform: each register returns a chain-scoped agent ID.
  platform = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").startsWith("/agents/register")) {
      void readBody(req).then((raw) => {
        const reg = JSON.parse(raw) as { chain_id?: number; handle?: string };
        const chainId = reg.chain_id ?? 0;
        registeredChains.add(chainId);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ agent_id: `${chainId}:reg:${reg.handle}` }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => platform.listen(PLATFORM_PORT, "127.0.0.1", r));

  // Fake gateway: record which agent IDs poll; never hand out a job.
  gateway = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/gateway/jobs/poll") {
      polledAgents.add(url.searchParams.get("agent") ?? "");
    }
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((r) => gateway.listen(GW_PORT, "127.0.0.1", r));

  server = exposeAsA2A(
    {
      name: "Multi Chain Agent",
      handle: "multi-ts",
      host: "127.0.0.1",
      port: AGENT_PORT,
      privyToken: "tok", // token auth — no wallet key needed
      aipEndpoint: `http://127.0.0.1:${PLATFORM_PORT}`,
      gatewayUrl: `http://127.0.0.1:${GW_PORT}`,
      viaGateway: true,
      chainIds: [97, 56, 8453],
      jobOfferings: [{ id: "echo", name: "echo", type: "JOB", price: 0, active: true }],
    },
    (input) => `Echo: ${input}`,
  );
  await server.start();
});

afterAll(async () => {
  await server.stop();
  gateway.close();
  platform.close();
});

describe("multi-chain", () => {
  it("registers once per chain and polls each chain's job queue", async () => {
    // Wait for all three chain-scoped agents to have polled at least once.
    const want = ["97:reg:multi-ts", "56:reg:multi-ts", "8453:reg:multi-ts"];
    for (let i = 0; i < 50 && !want.every((a) => polledAgents.has(a)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const chain of [97, 56, 8453]) expect(registeredChains.has(chain)).toBe(true);
    for (const agent of want) expect(polledAgents.has(agent)).toBe(true);
  });
});
