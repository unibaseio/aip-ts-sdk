/**
 * Cross-language wire contract tests. The golden JSON files under
 * contracts/fixtures/ (copied from the Go SDK, the source of truth) define
 * the wire format ALL AIP SDKs must serialize to identically.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig, AgentJobOffering } from "./types.js";
import { toAgentCard, toRegistrationMap } from "./types.js";

const FIXTURES = path.join(__dirname, "..", "contracts", "fixtures");

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

/** JSON round-trip so undefined-valued keys drop, matching Go's omitempty. */
function normalize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

// The canonical job offering used across fixtures (mirrors the Go contract test).
function jobOffering(): AgentJobOffering {
  return {
    id: "yes_no_probability",
    name: "yes_no_probability",
    description: "Estimates YES/NO probabilities for any prediction market topic.",
    type: "JOB",
    price: 0,
    priceV2: { type: "fixed", amount: 0.0015, currency: "USDC" },
    jobInput: "Will BTC break $150k by end of 2026?",
    jobOutput: "Topic: ...\nYES: <0-100>%\nNO: <0-100>%\nReasoning: ...",
    requirement: {
      type: "object",
      required: ["topic"],
      properties: { topic: { type: "string" } },
    },
    deliverable: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    slaMinutes: 1,
    active: true,
  };
}

// The canonical AgentConfig used for registration/card fixtures.
function agentConfig(): AgentConfig {
  return {
    name: "Prediction Market Agent",
    description: "Estimates YES/NO probabilities.",
    handle: "prediction_market_demo",
    capabilities: ["streaming"],
    skills: [
      {
        name: "YES/NO Probability",
        description: "Estimate the YES/NO probability of any topic.",
      },
    ],
    costModel: { baseCallFee: 0.0015 },
    currency: "USD",
    metadata: { version: "1.0.0", mode: "private" },
    endpointUrl: "",
    jobOfferings: [jobOffering()],
    chainId: 97,
  };
}

describe("cross-language wire contract", () => {
  it("agent_registration matches the fixture", () => {
    expect(normalize(toRegistrationMap(agentConfig()))).toEqual(readFixture("agent_registration"));
  });

  it("agent_card matches the fixture", () => {
    expect(normalize(toAgentCard(agentConfig(), "42", "0xRegistry"))).toEqual(
      readFixture("agent_card"),
    );
  });

  it("job_offering matches the fixture", () => {
    expect(normalize(jobOffering())).toEqual(readFixture("job_offering"));
  });
});
