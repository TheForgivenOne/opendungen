import { describe, expect, it } from "vitest";
import { SsrfError, assertPublicUrl, isPublicIp } from "./ssrf";
import type { createApp } from "../app";
import { providerConfigs } from "../db/schema";
import { createTestApp, setupAdmin } from "../testing";

type App = ReturnType<typeof createApp>;

// Closed-world DNS: only the listed hostnames resolve.
function mockLookup(table: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => table[hostname] ?? [];
}

const PUBLIC_DNS = mockLookup({
  "api.openai.com": ["172.64.155.209"],
  "example.com": ["93.184.216.34"],
  "evil.example.com": ["10.0.0.1"],
  "v6.example.com": ["2606:4700:4700::1111"],
});

describe("isPublicIp", () => {
  const cases: { ip: string; expected: boolean }[] = [
    { ip: "93.184.216.34", expected: true },
    { ip: "1.1.1.1", expected: true },
    { ip: "8.8.8.8", expected: true },
    { ip: "10.0.0.1", expected: false },
    { ip: "10.255.255.255", expected: false },
    { ip: "172.16.0.1", expected: false },
    { ip: "172.31.255.255", expected: false },
    { ip: "172.15.0.1", expected: true },
    { ip: "172.32.0.1", expected: true },
    { ip: "192.168.1.1", expected: false },
    { ip: "127.0.0.1", expected: false },
    { ip: "127.1.2.3", expected: false },
    { ip: "169.254.169.254", expected: false },
    { ip: "169.254.0.1", expected: false },
    { ip: "0.0.0.0", expected: false },
    { ip: "224.0.0.1", expected: false },
    { ip: "255.255.255.255", expected: false },
    { ip: "::1", expected: false },
    { ip: "::", expected: false },
    { ip: "fe80::1", expected: false },
    { ip: "fc00::1", expected: false },
    { ip: "fd00:ec2::254", expected: false },
    { ip: "ff02::1", expected: false },
    { ip: "2606:4700:4700::1111", expected: true },
    { ip: "2001:db8::1", expected: true },
    { ip: "not-an-ip", expected: false },
  ];
  it.each(cases)("$ip -> public=$expected", ({ ip, expected }) => {
    expect(isPublicIp(ip)).toBe(expected);
  });
});

describe("assertPublicUrl", () => {
  it("rejects loopback by default, allows it with the opt-in flag", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:11434")).rejects.toBeInstanceOf(SsrfError);
    await expect(
      assertPublicUrl("http://127.0.0.1:11434", { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it("rejects cloud metadata", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects hostnames resolving to private addresses", async () => {
    await expect(
      assertPublicUrl("http://evil.example.com/", { lookup: PUBLIC_DNS }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("ftp://example.com/x")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("gopher://example.com/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertPublicUrl("http://user:pass@example.com", { lookup: PUBLIC_DNS }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects unresolvable hostnames (fail closed)", async () => {
    await expect(
      assertPublicUrl("http://no-such-host.invalid/", { lookup: PUBLIC_DNS }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows public https hosts", async () => {
    await expect(
      assertPublicUrl("https://api.openai.com", { lookup: PUBLIC_DNS }),
    ).resolves.toBeUndefined();
  });

  it("allows literal public IPs without DNS", async () => {
    let calls = 0;
    await expect(
      assertPublicUrl("https://93.184.216.34/", {
        lookup: async (h) => {
          calls++;
          return PUBLIC_DNS(h);
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("provider SSRF enforcement", () => {
  async function postProvider(app: App, cookie: string, baseUrl: string) {
    return app.request("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        label: "Local",
        kind: "ollama",
        baseUrl,
        model: "m",
      }),
    });
  }

  it("rejects private baseUrls on create by default", async () => {
    const { app } = createTestApp();
    const { cookie } = await setupAdmin(app);
    // A non-default private address is still rejected without the flag
    // (the two literal local-Ollama defaults bypass this gate).
    const res = await postProvider(app, cookie, "http://10.0.0.5:11434");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("accepts private baseUrls with ALLOW_PRIVATE_PROVIDER_URLS", async () => {
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    const res = await postProvider(app, cookie, "http://127.0.0.1:11434");
    expect(res.status).toBe(201);
  });

  it("re-checks baseUrl on PATCH", async () => {
    const { app } = createTestApp("single", { env: { allowPrivateProviderUrls: true } });
    const { cookie } = await setupAdmin(app);
    const created = await postProvider(app, cookie, "http://127.0.0.1:11434");
    expect(created.status).toBe(201);
    const { provider } = (await created.json()) as { provider: { id: string } };
    // Flip to a strict app sharing the same database rows is not
    // possible per-app, so assert the PATCH path checks at all: a
    // credentials-bearing URL is rejected even in permissive mode.
    const res = await app.request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ baseUrl: "http://user:pass@example.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("blocks testConnection to private hosts by default", async () => {
    const { app, db } = createTestApp();
    const { cookie, userId } = await setupAdmin(app);
    // Seeded directly: the create endpoint would reject this URL.
    const now = Date.now();
    await db.insert(providerConfigs).values({
      id: "private-provider",
      userId,
      label: "Sneaky",
      kind: "ollama",
      baseUrl: "http://10.0.0.5:11434",
      model: "m",
      apiKeyEnc: "gcm1$AAAAAAAAAAAAAAAA$AA",
      isDefault: 0,
      createdAt: now,
    });
    const res = await app.request("/api/providers/private-provider/test", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error ?? "").toMatch(/public http\(s\) URL/);
  });
});
