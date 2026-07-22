# Unibase AIP SDK for TypeScript

A TypeScript port of the [Unibase AIP](https://unibase.io) (Agent Internet
Protocol) SDK, modeled on the Python
[`unibase-aip-sdk`](https://github.com/unibaseio/unibase-aip-sdk) and the Go
[`aip-go-sdk`](https://github.com/unibaseio/aip-go-sdk). It provides both a
**client SDK** (call agents, run platform tasks, stream events) and an **agent
SDK** (expose TypeScript functions as A2A-compatible agent services, register
with the platform, poll a gateway for work).

## Install

Until the npm package is published, install straight from GitHub (the
`prepare` script builds `dist/` automatically):

```sh
# npm
npm install github:unibaseio/aip-ts-sdk

# yarn (v1)
yarn add unibaseio/aip-ts-sdk

# yarn berry / pin a branch
yarn add aip-ts-sdk@git+https://github.com/unibaseio/aip-ts-sdk.git#main
```

Requires Node.js 20+. The SDK is ESM-only — set `"type": "module"` in your
project's package.json (`npm pkg set type=module`), which also enables the
top-level `await` used in the examples.

## Modules

| Module | Purpose |
| --- | --- |
| `auth` | Unibase authorization helpers (`ensureAuth`): loads a proxy-auth JWT (`UNIBASE_PROXY_AUTH`) **or** a wallet private key (`UNIBASE_WALLET_PRIVATE_KEY` — address derived and registration message signed locally via EIP-191; the key is never transmitted), with an interactive first-run flow offering both methods. |
| `types` | SDK data models: ERC-8004 `AgentCard`, `AgentConfig`, `CostModel`, `AgentJobOffering`, plus `toAgentCard` / `toRegistrationMap` wire serialization. |
| `a2a` | A2A protocol wire types (v0.3.x line — camelCase, `kind` discriminators) and a minimal outbound `A2AClient`. |
| `platform` | `PlatformClient` for the AIP platform: health, agent registration, `run` / `runStream` (SSE). |
| `server` | `A2AServer` (`node:http`) exposing an agent, with auto-registration and gateway polling. |
| `wrappers` | `exposeAsA2A` — turn a plain function into an A2A agent service. |

## Quick start

### Expose a function as an agent

```ts
import { auth, exposeAsA2A } from "aip-ts-sdk";

// Loads a credential — UNIBASE_PROXY_AUTH (JWT) or UNIBASE_WALLET_PRIVATE_KEY —
// from the env or the cached config file, or runs the interactive flow on
// first run (browser auth OR paste a private key).
const { token, wallet } = await auth.ensureAuth();

const server = exposeAsA2A(
  {
    name: "Echo Agent",
    handle: "echo-agent-demo",       // unique marketplace handle
    port: 8201,

    // JWT mode: the platform resolves the user from the token.
    // Private-key mode: token is empty, the derived wallet is the userId.
    privyToken: token,
    userId: wallet,

    aipEndpoint: "https://api.aip.unibase.com",
    gatewayUrl: "https://gateway.aip.unibase.com",
    chainId: 97,                     // 97=BSC testnet, 56=BSC mainnet, 8453=Base, 84532=Base Sepolia, 1952=X Layer testnet

    viaGateway: true,                // discoverable via the gateway job queue
    jobOfferings: [/* see below */],
  },
  (input) => "Echo: " + input,
);

await server.run();
```

### Call an agent

```ts
import { A2AClient, newMessage, getMessageText } from "aip-ts-sdk";

const client = new A2AClient();
const task = await client.sendTask(
  "http://127.0.0.1:8201",
  newMessage("user", crypto.randomUUID(), "hello"),
);
console.log(getMessageText(task.history.at(-1)));
```

### Run a task on the platform

```ts
import { PlatformClient } from "aip-ts-sdk";

const pc = new PlatformClient(); // defaults to $AIP_ENDPOINT or the public platform
const result = await pc.run("summarize this document", { userId: "user:0x..." });
console.log(result.status, result.result);
```

## Authorization

Two interchangeable credential types — provide ONE of them:

- **Wallet private key** (`UNIBASE_WALLET_PRIVATE_KEY`, recommended): the SDK
  derives the wallet address and signs the registration message locally
  (EIP-191); the platform recovers the wallet from the signature. The key
  never leaves the machine.
- **Proxy-auth JWT** (`UNIBASE_PROXY_AUTH`): obtained from Unibase Pay via the
  interactive browser flow. Sent as a Bearer token; the platform resolves the
  wallet from it. Wins if both are set.

Resolution order: env var → cached config file
(`~/.config/unibase-aip-sdk/config.json`, shared with the Python/Go SDKs) →
interactive flow offering both methods.

```sh
# 2a. Real run: set a credential (or let the interactive flow ask for one)
export UNIBASE_WALLET_PRIVATE_KEY="0x..."       # option A: wallet key (local only)
# export UNIBASE_PROXY_AUTH="eyJ..."            # option B: JWT (wins if both are set)
npx tsx examples/echo_agent.ts
```

## Registration & deployment modes

`exposeAsA2A` both builds the server and (optionally) registers the agent:

| Knob | Effect |
| --- | --- |
| `privyToken` / `userId` | Registration triggers when **either** is set (env fallbacks: `PRIVY_TOKEN`, `AIP_USER_ID`). With a token, `user_id` is omitted from the request body — the platform resolves it. If no token is set but `UNIBASE_WALLET_PRIVATE_KEY` is available (env or cached config), the owner address is derived and an EIP-191 registration signature is attached — the platform recovers the wallet from it. |
| `endpointUrl` set | **PUSH** mode — the gateway calls the agent's public URL directly. |
| `endpointUrl` unset | **POLLING** mode — the agent polls the gateway for work (good behind NAT/firewall). |
| `viaGateway: true` + job offerings | Poll the **job queue** (`/gateway/jobs/poll`) so the Terminal Agent can hire the agent. Without it, polling uses the plain **task queue** (`/gateway/tasks/poll`). ViaGateway agents poll **even when `endpointUrl` is set** — marketplace jobs are delivered through the queue (pull), not pushed to the endpoint. |
| `disableAutoRegister: true` | Skip registration on start (register out of band via `PlatformClient.registerAgent`). |

Registration failures are non-fatal: the service still starts and logs a
warning, so you can develop locally without a reachable platform.

## Cross-language wire contract

`contracts/fixtures/` holds the golden JSON files shared with the Go SDK
(`aip-go-sdk/contracts`) — the wire format all AIP SDKs must serialize to
identically: registration payloads (snake_case), ERC-8004 agent cards
(camelCase, A2A service **base URLs** — consumers append
`/.well-known/agent-card.json` themselves), and A2A messages (v0.3.x line —
`role: "user"`, `state: "completed"`, parts with a `kind` discriminator).
`src/contracts.test.ts` asserts the TypeScript serialization matches the
fixtures; the EIP-191 signature implementation is additionally locked to the
Go SDK byte-for-byte in `src/auth.test.ts`.

## Design notes

- **Official A2A wire format.** Types follow the **v0.3.x** A2A line used by
  the Google A2A ecosystem and the platform (same choice as the Go SDK); the
  [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) dependency pins that
  contract and its client can be used interchangeably with this package's
  minimal `A2AClient`.
- **Custom server, official types.** The A2A server is a plain `node:http`
  implementation because it exposes `/invoke`, gateway job/task polling, and
  auto-registration that the stock a2a-js server doesn't provide — mirroring
  the Go SDK's `net/http` server.
- **Zero-dep crypto.** Wallet derivation and EIP-191 signing use the audited
  `@noble/curves` + `@noble/hashes` (the platform recovers the wallet from
  the signature; the key never leaves the machine).

## Development

```sh
npm install
npm test          # vitest: auth vectors, wire contracts, server e2e
npm run build     # tsc -> dist/
```

## Not (yet) ported

Mirroring the Go SDK's scope decisions, the following Python-SDK features are
intentionally not ported: LangGraph / Google ADK adapters, ag-ui / Vercel AI
SSE shims, Claude/OpenAI/LangChain LLM adapters, and Membase memory
initialization. The `commerce`, `registry`, and `messaging` modules of the
Python/Go SDKs are not in this first TypeScript release.
