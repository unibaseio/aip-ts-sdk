/**
 * SDK data models, mirroring the Python SDK's `aip_sdk/types.py` and the Go
 * SDK's `types` package. JSON field names follow the reference SDKs — ERC-8004
 * agent cards use the camelCase keys defined by the spec, registration
 * payloads use snake_case (validated by the cross-language contract fixtures).
 */

/** A service endpoint defined in an Agent Card. */
export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
  a2aSkills?: string[];
}

/** An on-chain registration reference for an Agent Card. */
export interface AgentRegistration {
  agentId: string;
  agentRegistry: string;
}

export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface AgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
}

export interface AgentAuthentication {
  schemes: string[];
  credentials?: string;
}

/** A skill definition as represented in an Agent Card. */
export interface AgentSkillCard {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** A structured job offering as defined in an Agent Card (Virtuals ACP compatible). */
export interface AgentJobOffering {
  id: string | number;
  name: string;
  description?: string;
  type?: string;
  price: number;
  priceV2?: Record<string, unknown>;
  jobInput?: string;
  jobOutput?: string;
  requirement?: Record<string, unknown>;
  deliverable?: Record<string, unknown>;
  slaMinutes?: number;
  requiredFunds?: boolean;
  isManagedFund?: boolean;
  restricted?: boolean;
  hide?: boolean;
  active: boolean;
}

/** An auxiliary read-only resource defined in an Agent Card. */
export interface AgentJobResource {
  id: string | number;
  url: string;
  name: string;
  type?: string;
  description?: string;
}

/** A standard Agent Card following the ERC-8004 specification. */
export interface AgentCard {
  type: string;
  name: string;
  description: string;
  url: string;
  image?: string;
  iconUrl?: string;
  x402support: boolean;
  active: boolean;
  version: string;
  services: AgentService[];
  supportedTrust: string[];
  metadata?: Record<string, unknown>;
  userInterface?: string;
  FeedbackDataURI?: string;
  provider?: AgentProvider;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  authentication: AgentAuthentication;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkillCard[];
  /** null (not []) when absent — matches the Go SDK's nil-slice wire form. */
  jobOfferings: AgentJobOffering[] | null;
  jobResources: AgentJobResource[] | null;
  registrations: AgentRegistration[] | null;
  trustModels: string[];
}

/** The ERC-8004 standard type identifier for agent cards. */
export const AGENT_CARD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export const defaultSupportedTrust = (): string[] => [
  "reputation",
  "crypto-economic",
  "tee-attestation",
];

export const defaultTrustModels = (): string[] => [
  "feedback",
  "inference-validation",
  "tee-attestation",
];

export interface SkillInput {
  name: string;
  fieldType: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface SkillOutput {
  name: string;
  fieldType: string;
  description: string;
}

/** Configures an agent skill. */
export interface SkillConfig {
  name: string;
  description: string;
  inputs?: SkillInput[];
  outputs?: SkillOutput[];
}

/** Convert a SkillConfig into the API call dictionary form (snake_case). */
export function skillToMap(s: SkillConfig): Record<string, unknown> {
  return {
    name: s.name,
    description: s.description,
    inputs: (s.inputs ?? []).map((i) => ({
      name: i.name,
      field_type: i.fieldType,
      description: i.description,
    })),
    outputs: (s.outputs ?? []).map((o) => ({
      name: o.name,
      field_type: o.fieldType,
      description: o.description,
    })),
  };
}

/** Configures an agent's pricing. */
export interface CostModel {
  baseCallFee?: number;
  perAgentCallFee?: number;
  perUseFee?: number;
  perWriteFee?: number;
  perTokenFee?: number;
  customFees?: Record<string, number>;
}

/** Render the cost model, omitting unset fees, as the API expects. */
export function costModelToMap(c: CostModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.baseCallFee !== undefined) out.base_call_fee = c.baseCallFee;
  if (c.perAgentCallFee !== undefined) out.per_agent_call_fee = c.perAgentCallFee;
  if (c.perUseFee !== undefined) out.per_use_fee = c.perUseFee;
  if (c.perWriteFee !== undefined) out.per_write_fee = c.perWriteFee;
  if (c.perTokenFee !== undefined) out.per_token_fee = c.perTokenFee;
  out.custom_fees = c.customFees ?? {};
  return out;
}

/** Configures an agent. */
export interface AgentConfig {
  name: string;
  description?: string;
  handle?: string;
  skills?: SkillConfig[];
  capabilities?: string[];
  costModel?: CostModel;
  currency?: string;
  metadata?: Record<string, unknown>;
  endpointUrl?: string;
  jobOfferings?: AgentJobOffering[];
  jobResources?: AgentJobResource[];
  chainId?: number;
  /**
   * Token-less registration auth: an EIP-191 signature over `message`. The
   * platform recovers the wallet address from it (see `auth.signMessage`).
   */
  signature?: string;
  message?: string;
}

/** The primary price (base_call_fee), defaulting to 0.001. */
export function price(c: AgentConfig): number {
  return c.costModel?.baseCallFee || 0.001;
}

export function handleOrName(c: AgentConfig): string {
  return c.handle || c.name.toLowerCase().replaceAll(" ", "_");
}

/** Synthesize an ERC-8004 AgentCard from the config. */
export function toAgentCard(c: AgentConfig, agentId = "", registryAddress = ""): AgentCard {
  if (!agentId) agentId = "0";
  const handle = handleOrName(c);

  const url = c.endpointUrl || `http://localhost:8000/agents/${handle}/`;
  // The A2A service endpoint is the service BASE URL: consumers (e.g. the
  // platform's card refresher) append /.well-known/agent-card.json
  // themselves — including the path here doubled it up.
  const a2aEndpoint = url.replace(/\/+$/, "");

  const skills = c.skills ?? [];
  // Empty tags/examples are omitted entirely, matching Go's omitempty.
  const skillCards: AgentSkillCard[] = skills.map((s) => ({
    id: `${handle}_${s.name}`,
    name: s.name,
    description: s.description,
    ...(c.capabilities?.length ? { tags: c.capabilities } : {}),
    inputModes: ["text/plain"],
    outputModes: ["application/json"],
  }));
  const skillNames = skills.map((s) => s.name);

  const registrations: AgentRegistration[] | null = registryAddress
    ? [{ agentId, agentRegistry: registryAddress }]
    : null;

  return {
    type: AGENT_CARD_TYPE,
    name: c.name,
    description: c.description ?? "",
    url,
    x402support: true,
    active: true,
    version: "1.0.0",
    services: [
      { name: "A2A", endpoint: a2aEndpoint, a2aSkills: skillNames },
      { name: "web", endpoint: url },
    ],
    registrations,
    supportedTrust: defaultSupportedTrust(),
    metadata: c.metadata,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: ["Bearer"] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json"],
    skills: skillCards,
    jobOfferings: c.jobOfferings ?? null,
    jobResources: c.jobResources ?? null,
    trustModels: defaultTrustModels(),
    provider: { organization: "BitAgent", url: "https://bitagent.io" },
  };
}

/** Convert the config to the registration API format. */
export function toRegistrationMap(c: AgentConfig): Record<string, unknown> {
  const handle = handleOrName(c);
  const skills = c.skills ?? [];

  const out: Record<string, unknown> = {
    handle,
    card: toAgentCard(c),
    skills: skills.map(skillToMap),
    tasks: skills.map((s) => ({ name: s.name, description: s.description })),
    cost_model: costModelToMap(c.costModel ?? {}),
    price: { amount: price(c), currency: c.currency ?? "USD" },
    jobOfferings: c.jobOfferings ?? [],
    jobResources: c.jobResources ?? [],
    metadata: c.metadata ?? {},
    endpoint_url: c.endpointUrl ?? "",
    chain_id: c.chainId ?? 97,
  };
  // Token-less auth: the platform recovers the wallet from the signature.
  if (c.signature) {
    out.signature = c.signature;
    if (c.message) out.message = c.message;
  }
  return out;
}
