import { describe, expect, it } from "vitest";
import { emailProviders, MailerLiteProvider, PlunkProvider, type EmailLead } from "../src/automations/email.js";
import { loadConfig } from "../src/config.js";
import { TransientError } from "../src/core/errors.js";

// HTTP adapters are tested against a recording fetch; no request leaves the process.

function recorder(status = 200, json: unknown = {}) {
  const calls: { url: string; method?: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const lead: EmailLead = { email: "ania@example.test", tags: ["claude", "reel"], source: { channel: "instagram", flow: "f1", run: "r1", media: "18000000000000001" } };

describe("email providers", () => {
  it("Plunk: POST /v1/track with bearer key, event and source data", async () => {
    const { f, calls } = recorder(200, { success: true, contact: "ct_1" });
    const p = new PlunkProvider({ apiKey: "test_plunk_key", baseUrl: "https://plunk.example.test", fetch: f });
    expect(await p.push(lead)).toEqual({ id: "ct_1" });
    expect(calls).toEqual([
      {
        url: "https://plunk.example.test/v1/track",
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test_plunk_key", "content-type": "application/json" }),
        body: { event: "instagram-lead", email: "ania@example.test", subscribed: true, data: { source: "instagram", flow: "f1", media: "18000000000000001", tags: "claude,reel" } },
      },
    ]);
  });

  it("MailerLite: POST /api/subscribers into the step group or MAILERLITE_GROUP_ID", async () => {
    const { f, calls } = recorder(201, { data: { id: "123" } });
    const p = new MailerLiteProvider({ apiKey: "test_ml_key", baseUrl: "https://ml.example.test", groupId: "g_env", fetch: f });
    expect(await p.push(lead)).toEqual({ id: "123" });
    await p.push({ ...lead, group: "g_step" });
    expect(calls.map((c) => [c.url, c.headers.authorization, c.body])).toEqual([
      ["https://ml.example.test/api/subscribers", "Bearer test_ml_key", { email: "ania@example.test", groups: ["g_env"] }],
      ["https://ml.example.test/api/subscribers", "Bearer test_ml_key", { email: "ania@example.test", groups: ["g_step"] }],
    ]);
  });

  it("classifies errors without leaking the key or the email", async () => {
    const bad = new PlunkProvider({ apiKey: "test_plunk_key", baseUrl: "https://plunk.example.test", fetch: recorder(401, { message: "Invalid key" }).f });
    const err = await bad.push(lead).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransientError);
    expect((err as Error).message).toBe("plunk 401: Invalid key");
    const down = new MailerLiteProvider({ apiKey: "k", baseUrl: "https://ml.example.test", fetch: recorder(503).f });
    await expect(down.push(lead)).rejects.toBeInstanceOf(TransientError);
  });

  it("only configured providers are enabled; keys come from env", () => {
    expect(emailProviders(loadConfig({}))).toEqual({});
    const cfg = loadConfig({ PLUNK_API_KEY: "test_plunk_key", PLUNK_API_URL: "https://plunk.example.test/", MAILERLITE_API_KEY: "test_ml_key", MAILERLITE_GROUP_ID: "g1" });
    const p = emailProviders(cfg);
    expect(Object.keys(p).sort()).toEqual(["mailerlite", "plunk"]);
    expect(cfg.email.plunkApiUrl).toBe("https://plunk.example.test");
  });

  it("safe defaults: automations, autosend and sending are all off", () => {
    const cfg = loadConfig({});
    expect(cfg.automations).toEqual({ enabled: false, autosend: false, cooldownHours: 24 });
    expect(cfg.sendingEnabled).toBe(false);
    expect(cfg.approval).toBe("human");
  });
});
