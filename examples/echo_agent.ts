/**
 * Minimal marketplace agent — the TypeScript twin of the Python/Go quickstart
 * examples. Registers on-chain, publishes an `echo` job offering, and polls
 * the gateway job queue for work.
 *
 * Run (from the repo root):
 *
 *   export UNIBASE_WALLET_PRIVATE_KEY="0x<your_wallet_private_key>"
 *   npx tsx examples/echo_agent.ts
 *
 * Using a JWT instead? Set UNIBASE_PROXY_AUTH="eyJ..." — it wins if both are
 * set. With neither configured, the first run starts an interactive flow.
 */

import { auth, exposeAsA2A } from "../src/index.js";

// Loads a credential — UNIBASE_PROXY_AUTH (JWT) or UNIBASE_WALLET_PRIVATE_KEY —
// from the env or the cached config file, or runs the interactive flow on
// first run (browser auth OR paste a private key).
// JWT mode: { token, wallet }. Private-key mode: { token: "", wallet }.
const { token, wallet } = await auth.ensureAuth();

const server = exposeAsA2A(
  {
    name: "Echo Agent TS",
    handle: "echo-agent-ts-demo", // unique marketplace handle
    description: "Echoes back any text you send",
    host: "0.0.0.0",
    port: 8201,

    // Identity — JWT mode: platform resolves the user from the token.
    // Private-key mode: token is empty, the derived wallet is the userId.
    privyToken: token,
    userId: wallet,

    // Platform endpoints
    aipEndpoint: "https://api.aip.unibase.com",
    gatewayUrl: "https://gateway.aip.unibase.com",
    chainId: 97, // 97=BSC Testnet, 56=BSC Mainnet, 8453=Base, 84532=Base Sepolia, 1952=X Layer Testnet

    // POLLING mode — no endpointUrl means no public URL needed
    viaGateway: true,

    costModel: { baseCallFee: 0.001 },
    jobOfferings: [
      {
        id: "echo",
        name: "echo",
        description: "Echoes back any text you send",
        type: "JOB",
        price: 0,
        priceV2: { type: "fixed", amount: 0.001, currency: "USDC" },
        requirement: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
        },
        deliverable: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
        },
        slaMinutes: 1,
        active: true,
      },
    ],
  },
  (input) => {
    // Receives the job input, returns the deliverable.
    let text = input;
    try {
      const parsed = JSON.parse(input) as { text?: string };
      if (typeof parsed.text === "string") text = parsed.text;
    } catch {
      // plain-text input is fine too
    }
    return JSON.stringify({ text: `Echo: ${text}` });
  },
);

await server.run(AbortSignal.timeout(0x7fffffff));
