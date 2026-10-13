// SSRF protection for user-controlled provider baseUrls.
// Checks, in order: scheme is http(s); no embedded credentials; a
// literal-IP hostname must itself be public; otherwise every DNS
// answer for the hostname must be a public address.

export class SsrfError extends Error {
  constructor(message = "baseUrl must be a public http(s) URL") {
    super(message);
    this.name = "SsrfError";
  }
}

export interface SsrfOptions {
  // ALLOW_PRIVATE_PROVIDER_URLS=true skips the private-IP checks
  // (self-hosters running Ollama on localhost need this).
  allowPrivate?: boolean;
  // Narrow exception for kind=ollama only: the two literal local
  // defaults (http://localhost:11434, http://127.0.0.1:11434) are
  // always allowed without the private flag. Never passed for other
  // kinds; any other private address still requires the flag.
  allowLocalDefaults?: boolean;
  // Injectable for tests: hostname -> IP literals.
  lookup?: (hostname: string) => Promise<string[]>;
}

export async function assertPublicUrl(rawUrl: string, opts: SsrfOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError();
  }
  if (url.username !== "" || url.password !== "") {
    throw new SsrfError();
  }
  if (opts.allowLocalDefaults && isLocalOllamaDefault(url)) {
    return;
  }
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!hostname) {
    throw new SsrfError();
  }
  if (isIpLiteral(hostname)) {
    // A literal public IP needs no DNS round-trip.
    if (!opts.allowPrivate && !isPublicIp(hostname)) {
      throw new SsrfError();
    }
    return;
  }
  const addresses = await (opts.lookup ?? defaultLookup)(hostname);
  if (addresses.length === 0) {
    throw new SsrfError();
  }
  if (!opts.allowPrivate) {
    for (const address of addresses) {
      if (!isPublicIp(address)) {
        throw new SsrfError();
      }
    }
  }
}

export function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || host.includes(":");
}

// Exactly the two stock local-Ollama addresses (any path): http with
// host localhost/127.0.0.1 on port 11434. Anything else — other
// private IPs, other ports, other schemes — is not a default.
function isLocalOllamaDefault(url: URL): boolean {
  if (url.protocol !== "http:") {
    return false;
  }
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    return false;
  }
  return url.port === "11434";
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function ipv4ToInt(ip: string): number | null {
  if (!isIpv4Literal(ip)) {
    return null;
  }
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const addr = ipv4ToInt(ip);
  const net = ipv4ToInt(base);
  if (addr === null || net === null) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) >>> 0 === (net & mask) >>> 0;
}

// True unless the address falls in a non-public range: RFC1918,
// loopback, link-local (incl. cloud metadata 169.254.169.254),
// 0.0.0.0/8, multicast, broadcast — and the IPv6 equivalents
// (loopback ::1, link-local fe80::/10, unique-local fc00::/7
// incl. fd00:ec2::254, unspecified ::, multicast ff00::/8).
export function isPublicIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.includes(":")) {
    return isPublicIpv6(lower);
  }
  if (!isIpv4Literal(ip)) {
    return false;
  }
  if (
    inCidr(ip, "10.0.0.0", 8) ||
    inCidr(ip, "172.16.0.0", 12) ||
    inCidr(ip, "192.168.0.0", 16) ||
    inCidr(ip, "127.0.0.0", 8) ||
    inCidr(ip, "169.254.0.0", 16) ||
    inCidr(ip, "0.0.0.0", 8) ||
    inCidr(ip, "224.0.0.0", 4) ||
    ip === "255.255.255.255"
  ) {
    return false;
  }
  return true;
}

function expandIpv6(ip: string): number[] | null {
  // Expands to eight 16-bit groups; null on malformed input.
  const halves = ip.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) {
        return null;
      }
      out.push(parseInt(g, 16));
    }
    return out;
  };
  // An embedded trailing IPv4 (e.g. ::ffff:1.2.3.4) counts as two groups.
  const withV4 = (groups: number[], tail: string): number[] | null => {
    if (!isIpv4Literal(tail)) {
      return null;
    }
    const n = ipv4ToInt(tail) as number;
    groups.push((n >>> 16) & 0xffff, n & 0xffff);
    return groups;
  };
  const expandHalf = (half: string): number[] | null => {
    const lastColon = half.lastIndexOf(":");
    const tail = lastColon === -1 ? half : half.slice(lastColon + 1);
    if (tail.includes(".")) {
      const head = lastColon === -1 ? "" : half.slice(0, lastColon);
      const groups = parse(head);
      if (!groups) {
        return null;
      }
      return withV4(groups, tail);
    }
    return parse(half);
  };
  const left = expandHalf(halves[0] ?? "");
  const right = halves.length === 2 ? expandHalf(halves[1] ?? "") : [];
  if (!left || !right) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPublicIpv6(ip: string): boolean {
  // Zone ids (fe80::1%eth0) never come from DNS; reject them outright.
  if (ip.includes("%")) {
    return false;
  }
  const groups = expandIpv6(ip);
  if (!groups) {
    return false;
  }
  const allZero = groups.every((g) => g === 0);
  if (allZero) {
    return false; // ::
  }
  if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) {
    return false; // ::1
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return false; // fe80::/10
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return false; // fc00::/7 (incl. fd00:ec2::254)
  }
  if ((groups[0] & 0xff00) === 0xff00) {
    return false; // ff00::/8 multicast
  }
  return true;
}

// Platform DNS: Node's resolver when available, otherwise DNS-over-HTTPS
// against Cloudflare's resolver (plain fetch works inside Workers, where
// node:dns does not exist). Failures resolve to [] and the caller treats
// an unresolvable hostname as rejected (fail closed).
async function defaultLookup(hostname: string): Promise<string[]> {
  try {
    const dns = await tryNodeDns();
    if (dns) {
      const [v4, v6] = await Promise.all([
        dns.resolve4(hostname).catch(() => [] as string[]),
        dns.resolve6(hostname).catch(() => [] as string[]),
      ]);
      return [...v4, ...v6];
    }
  } catch {
    // Fall through to DNS-over-HTTPS.
  }
  return lookupOverHttps(hostname);
}

async function tryNodeDns(): Promise<{
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
} | null> {
  try {
    // Dynamic import: node:dns must never be a static import or the
    // Workers bundle breaks (nodejs_compat is not enabled).
    const dns = (await import("node:dns/promises")) as unknown as {
      resolve4(host: string): Promise<string[]>;
      resolve6(host: string): Promise<string[]>;
    };
    if (typeof dns.resolve4 === "function" && typeof dns.resolve6 === "function") {
      return dns;
    }
    return null;
  } catch {
    return null;
  }
}

async function lookupOverHttps(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"]) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: "application/dns-json" } },
      );
      if (!res.ok) {
        continue;
      }
      const body = (await res.json()) as {
        Answer?: { type: number; data: string }[];
      };
      for (const answer of body.Answer ?? []) {
        // 1 = A, 28 = AAAA.
        if ((type === "A" && answer.type === 1) || (type === "AAAA" && answer.type === 28)) {
          out.push(answer.data.replace(/\.$/, ""));
        }
      }
    } catch {
      // One failed family must not fail the other; total failure
      // yields [] and the hostname is rejected.
    }
  }
  return out;
}
