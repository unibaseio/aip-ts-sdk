/**
 * Expose plain functions as A2A-compatible agent services, mirroring
 * `aip_sdk/wrappers/generic.py` and the Go SDK's `wrappers` package.
 */

import { randomUUID } from "node:crypto";
import * as auth from "./auth.js";
import type { Message, Task } from "./a2a.js";
import { getMessageText, newMessage } from "./a2a.js";
import type { TaskHandler } from "./server.js";
import { A2AServer } from "./server.js";
import type {
  AgentJobOffering,
  AgentJobResource,
  AgentSkillCard,
  CostModel,
  SkillConfig,
} from "./types.js";
import { AGENT_CARD_TYPE, defaultSupportedTrust, defaultTrustModels } from "./types.js";

/** A plain agent function: receives the input text, returns the deliverable. */
export type AgentFunction = (input: string, task: Task) => string | Promise<string>;

/** Options for exposeAsA2A. Only `name` is required. */
export interface ExposeOptions {
  name: string;
  description?: string;
  host?: string;
  port?: number;
  skills?: AgentSkillCard[];
  version?: string;

  /**
   * Account / registration integration. Registration triggers when either
   * `privyToken` (preferred — the platform resolves the user from it) or
   * `userId` (token-less path) is set; falls back to the PRIVY_TOKEN and
   * AIP_USER_ID env vars respectively. If neither is set, the wallet address
   * is derived locally from UNIBASE_WALLET_PRIVATE_KEY (env or cached config)
   * and an EIP-191 registration signature is attached.
   */
  handle?: string;
  userId?: string;
  privyToken?: string;
  aipEndpoint?: string;
  gatewayUrl?: string;
  chainId?: number;
  currency?: string;
  costModel?: CostModel;
  metadata?: Record<string, unknown>;
  jobOfferings?: AgentJobOffering[];
  jobResources?: AgentJobResource[];
  /** "" (or unset) => POLLING mode; a URL => PUSH mode. */
  endpointUrl?: string;
  /** Poll the gateway job queue so the Terminal Agent can hire the agent. */
  viaGateway?: boolean;
  /** Skip registration on start (register out of band). */
  disableAutoRegister?: boolean;
}

/** The registration message signed in wallet-key mode (platform default). */
const REGISTRATION_MESSAGE = "Create an AIP agent";

/**
 * Turn a plain function into an A2A agent service: builds the agent card,
 * resolves credentials, wires auto-registration and gateway polling, and
 * returns the (not yet started) server. Call `server.run()` to serve.
 */
export function exposeAsA2A(options: ExposeOptions, fn: AgentFunction): A2AServer {
  const host = options.host || "0.0.0.0";
  const port = options.port || 8000;
  const handle = options.handle || options.name.toLowerCase().replaceAll(" ", "_");

  const discoveryUrl = options.endpointUrl || `http://${host}:${port}`;
  const skillNames = (options.skills ?? []).map((s) => s.name);

  const card = {
    type: AGENT_CARD_TYPE,
    name: options.name,
    description: options.description ?? "",
    url: discoveryUrl,
    x402support: true,
    active: true,
    version: options.version || "1.0.0",
    services: [
      // The A2A service endpoint is the service BASE URL: consumers (e.g. the
      // platform's card refresher) append /.well-known/agent-card.json
      // themselves — including the path here doubled it up.
      { name: "A2A", endpoint: discoveryUrl, a2aSkills: skillNames },
      { name: "web", endpoint: discoveryUrl },
    ],
    registrations: null,
    supportedTrust: defaultSupportedTrust(),
    metadata: options.metadata,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: ["Bearer"] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json"],
    skills: options.skills ?? [],
    jobOfferings: options.jobOfferings ?? null,
    jobResources: options.jobResources ?? null,
    trustModels: defaultTrustModels(),
  };

  const taskHandler: TaskHandler = async (task: Task, message: Message) => {
    const input = getMessageText(message);
    const output = await fn(input, task);
    return [newMessage("agent", randomUUID(), output)];
  };

  // Resolve account integration settings.
  let resolvedUserId = options.userId || process.env.AIP_USER_ID || "";
  const privyToken = options.privyToken || process.env.PRIVY_TOKEN || "";
  let signature = "";
  let signedMessage = "";
  if (!privyToken) {
    // Wallet-key mode: without a Bearer token the platform authenticates
    // registration by recovering the wallet from an EIP-191 signature.
    // Derive the owner address and sign the registration message locally from
    // UNIBASE_WALLET_PRIVATE_KEY (env or cached config) — the key itself
    // never leaves the machine.
    const key = auth.loadPrivateKey();
    if (key) {
      try {
        const wallet = auth.walletFromPrivateKey(key);
        if (resolvedUserId && resolvedUserId.toLowerCase() !== wallet.toLowerCase()) {
          console.warn(
            `wrappers: userId ${resolvedUserId} does not match the wallet derived from ` +
              `UNIBASE_WALLET_PRIVATE_KEY (${wallet}); the platform will reject the registration`,
          );
        } else {
          if (!resolvedUserId) resolvedUserId = wallet;
          signedMessage = REGISTRATION_MESSAGE;
          signature = auth.signMessage(key, signedMessage);
        }
      } catch (e) {
        console.warn(`wrappers: ignoring invalid UNIBASE_WALLET_PRIVATE_KEY: ${(e as Error).message}`);
      }
    }
  }

  const autoRegister = !options.disableAutoRegister;
  let registrationConfig;
  // Registration needs an identity: either a Privy token (the platform
  // resolves the user from it) or a user ID for the token-less path.
  if ((resolvedUserId || privyToken) && (autoRegister || options.gatewayUrl)) {
    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    if (options.viaGateway) metadata.via_gateway = true;
    registrationConfig = {
      handle,
      name: options.name,
      description: options.description,
      userId: resolvedUserId,
      privyToken,
      signature,
      message: signedMessage,
      aipEndpoint: options.aipEndpoint,
      endpointUrl: options.endpointUrl ?? "",
      gatewayUrl: options.gatewayUrl,
      viaGateway: options.viaGateway,
      chainId: options.chainId,
      currency: options.currency,
      skills: (options.skills ?? []).map(
        (s): SkillConfig => ({ name: s.name, description: s.description }),
      ),
      costModel: options.costModel ?? { baseCallFee: 0.001 },
      metadata,
      jobOfferings: options.jobOfferings,
      jobResources: options.jobResources,
    };
  }

  return new A2AServer(card, taskHandler, host, port, registrationConfig, autoRegister);
}
