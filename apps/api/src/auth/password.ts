import { scrypt } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

// Password hashing with scrypt via @noble/hashes. Pure JS, so it runs on
// Cloudflare Workers (argon2 needs native code and does not).
// Stored format: scrypt$N=<n>$r=<r>$p=<p>$<salt-hex>$<hash-hex>
const N = 16384;
const R = 8;
const P = 1;
const DKLEN = 32;
const SALT_LEN = 16;

const encoder = new TextEncoder();

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scrypt(encoder.encode(password), salt, {
    N,
    r: R,
    p: P,
    dkLen: DKLEN,
  });
  return `scrypt$N=${N}$r=${R}$p=${P}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

function parseParam(part: string, name: string): number | null {
  const [k, v] = part.split("=");
  if (k !== name || v === undefined) {
    return null;
  }
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Constant-time comparison; returns false (rather than throwing) for any
// malformed stored hash.
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      return false;
    }
    const n = parseParam(parts[1], "N");
    const r = parseParam(parts[2], "r");
    const p = parseParam(parts[3], "p");
    if (n === null || r === null || p === null) {
      return false;
    }
    const salt = hexToBytes(parts[4]);
    const expected = hexToBytes(parts[5]);
    const actual = scrypt(encoder.encode(password), salt, {
      N: n,
      r,
      p,
      dkLen: expected.length,
    });
    if (actual.length !== expected.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < actual.length; i++) {
      diff |= actual[i] ^ expected[i];
    }
    return diff === 0;
  } catch {
    return false;
  }
}
