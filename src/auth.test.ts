import { describe, expect, it } from "vitest";
import { extractWallet, signMessage, walletFromPrivateKey } from "./auth.js";

// Known vectors shared with the Go SDK's auth tests.
const ANVIL0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("walletFromPrivateKey", () => {
  it("derives the well-known vector addresses", () => {
    expect(
      walletFromPrivateKey("0x0000000000000000000000000000000000000000000000000000000000000001"),
    ).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(walletFromPrivateKey(ANVIL0)).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    // without 0x prefix
    expect(walletFromPrivateKey(ANVIL0.slice(2))).toBe(
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
  });

  it("rejects invalid keys", () => {
    for (const bad of ["", "0x1234", "not-hex", "0xzz00"]) {
      expect(() => walletFromPrivateKey(bad)).toThrow();
    }
  });
});

describe("signMessage", () => {
  it("matches the Go SDK's signature byte-for-byte (RFC 6979 deterministic)", () => {
    // Produced by the Go SDK's auth.SignMessage and cross-checked against the
    // platform's eth_account recovery — the cross-language contract vector.
    expect(signMessage(ANVIL0, "Create an AIP agent")).toBe(
      "0xe3af9d802998759c2b4dc4eb2faa96e4cce4968c23fa9ce409344fc52a4d1bc6616f8e7b8cce12915e2ba92d3924e33171849f259b4bb919b332bf26190664c51b",
    );
  });
});

describe("extractWallet", () => {
  it("returns the sub claim", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user:0xABC" })).toString("base64url");
    expect(extractWallet(`e30.${payload}.sig`)).toBe("user:0xABC");
  });

  it("returns empty for malformed tokens", () => {
    expect(extractWallet("nope")).toBe("");
    expect(extractWallet("")).toBe("");
  });
});
