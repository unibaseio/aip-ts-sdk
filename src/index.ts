/**
 * Unibase AIP SDK for TypeScript.
 *
 * A TypeScript port of the Unibase AIP (Agent Internet Protocol) SDK, modeled
 * on the Python `unibase-aip-sdk` and the Go `aip-go-sdk`. It provides both a
 * client SDK (call agents, run platform tasks) and an agent SDK (expose
 * functions as A2A-compatible agent services, register with the platform,
 * poll a gateway for work).
 */

export * as auth from "./auth.js";
export * from "./types.js";
export * from "./a2a.js";
export { PlatformClient, defaultBaseUrl, RegistrationError } from "./platform.js";
export type { EventData, RunOptions, RunResult, RegisterAgentOptions } from "./platform.js";
export { A2AServer, extractAgentText } from "./server.js";
export type { RegistrationConfig, TaskHandler } from "./server.js";
export { exposeAsA2A } from "./wrappers.js";
export type { AgentFunction, ExposeOptions } from "./wrappers.js";
