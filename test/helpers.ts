import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmailProviders } from "../src/automations/email.js";
import { loadConfig, type Config } from "../src/config.js";
import { FakeConnector } from "../src/connectors/fake/index.js";
import { saveAccount } from "../src/connectors/meta/account.js";
import { MetaConnector } from "../src/connectors/meta/index.js";
import { AGENT_SCOPES, Keys, SCOPES } from "../src/core/auth.js";
import { openDb } from "../src/core/db.js";
import { Service } from "../src/core/service.js";
import { createLogger } from "../src/log.js";
import { createApp } from "../src/server.js";

export const NOW = Date.parse("2026-10-31T12:00:00Z");
export const ENC_KEY = "a".repeat(64);
export const APP_SECRET = "test_app_secret";
export const AGENT_KEY = "sk_test_agent";
export const ADMIN_KEY = "sk_test_admin";
export const IG = { igUserId: "17841400000000001", username: "wozu_co", pageId: "100000000000001", pageToken: "EAAtestpagetoken" };

export const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "meta", `${name}.json`), "utf8"));

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    DB_PATH: ":memory:",
    SENDING_ENABLED: "true",
    TOKEN_ENC_KEY: ENC_KEY,
    META_APP_ID: "1234567890",
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOKS_ENABLED: "true",
    WEBHOOK_VERIFY_TOKEN: "verify_me",
    PUBLIC_URL: "https://inbox.example.test",
    ...env,
  });
}

export interface Clock {
  t: number;
  now: () => number;
}

export function clock(t = NOW): Clock {
  const c: Clock = { t, now: () => c.t };
  return c;
}

/** Service with the fake connector only. */
export function fakeSetup(env: Record<string, string> = {}, opts: { email?: EmailProviders } = {}) {
  const c = clock();
  const db = openDb(":memory:");
  const config = testConfig(env);
  const fake = new FakeConnector(c.now);
  const svc = new Service({ db, config, log: createLogger("silent"), connectors: [fake], now: c.now, email: opts.email });
  const keys = new Keys(db);
  keys.ensure("agent", AGENT_KEY, AGENT_SCOPES);
  keys.ensure("admin", ADMIN_KEY, SCOPES);
  return { db, svc, fake, clock: c, config, ...createApp(svc) };
}

// ---- mocked Graph API -------------------------------------------------------

export interface GraphCall {
  method: string;
  path: string;
  params: Record<string, string>;
  body?: unknown;
}

type Handler = (call: GraphCall) => unknown;

/** Routes Graph requests to fixture handlers and records every call. Unknown routes → Graph error 100. */
export function graphMock(routes: [string, RegExp, Handler][]) {
  const calls: GraphCall[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, "");
    const params = Object.fromEntries(u.searchParams);
    const call: GraphCall = { method, path, params, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    for (const [m, re, h] of routes) {
      if (m === method && re.test(path)) {
        const out = h(call);
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: { message: `no mock for ${method} ${path}`, code: 100 } }), { status: 400 });
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

export const igRoutes = (): [string, RegExp, Handler][] => [
  ["GET", /^100000000000001\/conversations$/, () => fixture("conversations")],
  ["GET", /AAAA1\/messages$/, () => fixture("messages_conv1")],
  ["GET", /AAAA2\/messages$/, () => fixture("messages_conv2")],
  ["GET", /AAAA3\/messages$/, () => ({ data: [] })],
  ["GET", /^17841400000000001\/media$/, () => fixture("media")],
  ["GET", /^18000000000000001\/comments$/, () => fixture("comments_media1")],
  ["GET", /^17841400000000001\/tags$/, () => fixture("tags")],
  ["GET", /^17841400000000001$/, (c) =>
    c.params.fields?.includes("mentioned_comment")
      ? { mentioned_comment: { text: "@wozu_co sprawdź to", username: "tester_two", timestamp: "2026-10-31T11:58:00+0000" }, id: IG.igUserId }
      : { id: IG.igUserId }],
  ["GET", /^6000000000000005$/, () => ({ username: "tester_one" })],
  ["POST", /^100000000000001\/messages$/, () => ({ recipient_id: "6000000000000001", message_id: "aWdfZAG1sent1" })],
  ["POST", /^\d+\/replies$/, () => ({ id: "17900000000000099" })],
  ["POST", /^17841400000000001\/mentions$/, () => ({ id: "17900000000000098" })],
  ["POST", /^\d+$/, () => ({ success: true })],
  ["DELETE", /^\d+$/, () => ({ success: true })],
];

/** Service with the Meta connector wired to the Graph mock and a connected account. */
export function metaSetup(env: Record<string, string> = {}, routes = igRoutes(), opts: { email?: EmailProviders } = {}) {
  const c = clock();
  const db = openDb(":memory:");
  const config = testConfig(env);
  const g = graphMock(routes);
  const meta = new MetaConnector(db, config, { fetch: g.fetch, now: c.now });
  saveAccount(db, ENC_KEY, IG);
  const svc = new Service({ db, config, log: createLogger("silent"), connectors: [meta], now: c.now, email: opts.email });
  const keys = new Keys(db);
  keys.ensure("agent", AGENT_KEY, AGENT_SCOPES);
  keys.ensure("admin", ADMIN_KEY, SCOPES);
  return { db, svc, meta, graph: g, clock: c, config, ...createApp(svc) };
}

export const auth = (key: string) => ({ authorization: `Bearer ${key}` });
