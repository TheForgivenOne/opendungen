import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// AES-GCM secret encryption via Web Crypto (runs on Workers and Node 22).
// The data key is derived per SESSION_SECRET with HKDF-SHA256, so rotating
// SESSION_SECRET invalidates every stored provider key (see README).
// Plaintext is never logged. Stored format:
//   gcm1$<iv-hex>$<ciphertext-base64>

const HKDF_INFO = "opendungen-provider-keys";
const IV_LEN = 12;

const encoder = new TextEncoder();

async function dataKey(sessionSecret: string): Promise<CryptoKey> {
  const ikm = utf8ToBytes(sessionSecret);
  // Uint8Array.from narrows noble's ArrayBufferLike views to plain
  // ArrayBuffers for the DOM BufferSource parameters below.
  const keyBytes = Uint8Array.from(
    hkdf(sha256, ikm, new Uint8Array(0), utf8ToBytes(HKDF_INFO), 32),
  );
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(raw: string): Uint8Array {
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptSecret(sessionSecret: string, plaintext: string): Promise<string> {
  const key = await dataKey(sessionSecret);
  const iv = Uint8Array.from(randomBytes(IV_LEN));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `gcm1$${bytesToHex(iv)}$${toBase64(new Uint8Array(ciphertext))}`;
}

// Throws on tampered input or a wrong SESSION_SECRET (GCM auth failure).
// Callers map this to a generic error; never echo the secret.
export async function decryptSecret(sessionSecret: string, stored: string): Promise<string> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "gcm1") {
    throw new Error("unsupported encrypted secret format");
  }
  const key = await dataKey(sessionSecret);
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = Uint8Array.from(hexToBytes(parts[1]));
    ciphertext = Uint8Array.from(fromBase64(parts[2]));
  } catch {
    throw new Error("malformed encrypted secret");
  }
  if (iv.length !== IV_LEN) {
    throw new Error("malformed encrypted secret");
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new Error("failed to decrypt secret");
  }
  return new TextDecoder().decode(plaintext);
}
