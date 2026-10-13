import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

const SECRET = "test-session-secret-for-crypto-tests";

describe("crypto", () => {
  it("round-trips a secret", async () => {
    const stored = await encryptSecret(SECRET, "sk-live-12345");
    expect(stored).toMatch(/^gcm1\$/);
    expect(stored).not.toContain("sk-live-12345");
    await expect(decryptSecret(SECRET, stored)).resolves.toBe("sk-live-12345");
  });

  it("round-trips empty and long secrets", async () => {
    await expect(decryptSecret(SECRET, await encryptSecret(SECRET, ""))).resolves.toBe("");
    const long = "k".repeat(2000);
    await expect(decryptSecret(SECRET, await encryptSecret(SECRET, long))).resolves.toBe(long);
  });

  it("uses a random IV (same plaintext encrypts differently)", async () => {
    const a = await encryptSecret(SECRET, "same");
    const b = await encryptSecret(SECRET, "same");
    expect(a).not.toBe(b);
  });

  it("detects tampering (GCM auth)", async () => {
    const stored = await encryptSecret(SECRET, "sk-live-12345");
    const parts = stored.split("$");
    const tampered = `${parts[0]}$${parts[1]}$${parts[2].slice(0, -4)}AAAA`;
    await expect(decryptSecret(SECRET, tampered)).rejects.toThrow();
  });

  it("rejects malformed stored values", async () => {
    await expect(decryptSecret(SECRET, "not-a-secret")).rejects.toThrow();
    await expect(decryptSecret(SECRET, "gcm1$zz$!!!")).rejects.toThrow();
  });

  it("fails with the wrong session secret", async () => {
    const stored = await encryptSecret(SECRET, "sk-live-12345");
    await expect(decryptSecret("a-different-secret", stored)).rejects.toThrow();
  });
});
