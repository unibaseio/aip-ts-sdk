/**
 * Unibase authorization helpers shared by SDK consumers.
 *
 * Two interchangeable credential types — provide ONE of them:
 *
 * - **Proxy-auth JWT** (`UNIBASE_PROXY_AUTH`): obtained from Unibase Pay via
 *   the interactive browser flow. Sent as a Bearer token; the platform
 *   resolves the wallet from it.
 * - **Wallet private key** (`UNIBASE_WALLET_PRIVATE_KEY`): the SDK derives
 *   the wallet address and signs the registration message locally (EIP-191);
 *   the platform recovers the wallet from the signature. The key never
 *   leaves the machine.
 *
 * Resolution order: env var -> cached config file -> interactive flow (which
 * lets the user pick either method). Mirrors the Python SDK's `aip_sdk.auth`
 * module and the Go SDK's `auth` package.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

/** Path to the cached auth config (shared with the Python and Go SDKs). */
export function configFile(): string {
  return path.join(os.homedir(), ".config", "unibase-aip-sdk", "config.json");
}

function payUrl(): string {
  return process.env.UNIBASE_PAY_URL ?? "https://api.pay.unibase.com";
}

function readConfig(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

/** Merge updates into the config file (0600 perms). */
function writeConfig(updates: Record<string, string | undefined>): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cfg = readConfig();
  for (const [k, v] of Object.entries(updates)) {
    if (v) cfg[k] = v;
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Read UNIBASE_PROXY_AUTH from the environment, then the config file. */
export function loadToken(): string {
  return process.env.UNIBASE_PROXY_AUTH || readConfig().UNIBASE_PROXY_AUTH || "";
}

/** Persist the token (and optional agent identity) to the config file. */
export function saveToken(token: string, agentId?: string, agentWallet?: string): void {
  writeConfig({
    UNIBASE_PROXY_AUTH: token,
    AGENT_ID: agentId,
    AGENT_WALLET: agentWallet,
  });
  console.log(`  saved auth token to ${configFile()}`);
}

/** Read UNIBASE_WALLET_PRIVATE_KEY from the environment, then the config file. */
export function loadPrivateKey(): string {
  return process.env.UNIBASE_WALLET_PRIVATE_KEY || readConfig().UNIBASE_WALLET_PRIVATE_KEY || "";
}

/**
 * Persist the wallet private key to the config file (0600 perms).
 * The key is stored locally only — it is never sent to the platform.
 */
export function savePrivateKey(key: string): void {
  writeConfig({ UNIBASE_WALLET_PRIVATE_KEY: key });
  console.log(`  saved wallet key to ${configFile()} (never sent to the platform)`);
}

/** Decode the JWT payload and return its `sub` claim (wallet address). */
export function extractWallet(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}

function normalizeKey(privateKey: string): Uint8Array {
  const hex = privateKey.trim().replace(/^0x/, "");
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch (e) {
    throw new Error(`invalid private key hex: ${(e as Error).message}`);
  }
  if (bytes.length !== 32) {
    throw new Error(`invalid private key length: ${bytes.length} bytes (want 32)`);
  }
  return bytes;
}

/** Format a 20-byte address with EIP-55 checksum casing. */
function checksumAddress(addr: Uint8Array): string {
  const lower = bytesToHex(addr);
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    out += c >= "a" && c <= "f" && hash[i]! >= "8" ? c.toUpperCase() : c;
  }
  return "0x" + out;
}

/**
 * Derive the EIP-55 checksummed wallet address from a hex private key.
 * Purely local — the key is never transmitted.
 */
export function walletFromPrivateKey(privateKey: string): string {
  const key = normalizeKey(privateKey);
  const pub = secp256k1.getPublicKey(key, false); // 65 bytes, 0x04 prefix
  const addr = keccak_256(pub.subarray(1)).subarray(12);
  return checksumAddress(addr);
}

/**
 * Sign a message with the private key (EIP-191 personal sign, offline).
 * The platform recovers the wallet address from this signature during
 * token-less registration — the key itself is never transmitted.
 * Returns the 65-byte r||s||v signature as 0x-prefixed hex.
 */
export function signMessage(privateKey: string, message: string): string {
  const key = normalizeKey(privateKey);
  const msgBytes = utf8ToBytes(message);
  const prefixed = new Uint8Array([
    ...utf8ToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`),
    ...msgBytes,
  ]);
  const digest = keccak_256(prefixed);
  const sig = secp256k1.sign(digest, key); // RFC 6979 deterministic, low-s
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (27 + sig.recovery).toString(16).padStart(2, "0");
  return `0x${r}${s}${v}`;
}

export interface Credentials {
  /** Proxy-auth JWT; empty string in private-key mode. */
  token: string;
  /** Wallet address — from the JWT `sub` claim or derived from the key. */
  wallet: string;
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
}

/**
 * Interactive first-run flow. Lets the user pick a credential type:
 * browser authorization (JWT) or a wallet private key.
 * Private-key mode returns `{ token: "", wallet }`.
 */
export async function interactiveAuth(): Promise<Credentials> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n=== Unibase Authorization ===");
    console.log("Choose an authorization method:");
    console.log("  1) Browser authorization — open a URL, approve, paste the JWT token");
    console.log("  2) Wallet private key — paste a hex private key (stored locally only)");
    const choice = (await ask(rl, "Choice [1]: ")) || "1";

    if (choice === "2") {
      const key = await ask(rl, "\nPaste your wallet private key (hex) and press Enter:\n  Private key: ");
      if (!key) throw new Error("no private key provided — aborted");
      const wallet = walletFromPrivateKey(key);
      console.log(`  wallet: ${wallet}`);
      savePrivateKey(key);
      return { token: "", wallet };
    }

    console.log("\n[1/3] Fetching authorization URL ...");
    const resp = await fetch(`${payUrl()}/v1/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "true",
    });
    const data = (await resp.json()) as Record<string, unknown>;
    const authUrl = (data.auth_url ?? data.authUrl) as string | undefined;
    if (!authUrl) throw new Error(`no auth URL in response: ${JSON.stringify(data)}`);

    console.log(`\n[2/3] Open this URL in your browser and approve:\n\n  ${authUrl}\n`);
    console.log("[3/3] Paste your Authorization token below and press Enter:");
    const token = await ask(rl, "  Token: ");
    if (!token) throw new Error("no token provided — aborted");
    saveToken(token);
    return { token, wallet: extractWallet(token) };
  } finally {
    rl.close();
  }
}

/**
 * Return usable credentials, running the interactive flow if nothing is
 * cached. JWT mode returns `{ token, wallet }`; private-key mode returns
 * `{ token: "", wallet }` with the address derived locally from the key.
 */
export async function ensureAuth(): Promise<Credentials> {
  const token = loadToken();
  if (token) return { token, wallet: extractWallet(token) };

  const key = loadPrivateKey();
  if (key) return { token: "", wallet: walletFromPrivateKey(key) };

  return interactiveAuth();
}
