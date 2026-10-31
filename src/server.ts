import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { apiRoutes } from "./api/routes.js";
import { MetaConnector } from "./connectors/meta/index.js";
import { completeLogin, consumeState } from "./connectors/meta/oauth.js";
import { verifyChallenge, verifySignature, type WebhookPayload } from "./connectors/meta/webhook.js";
import { bearer, Keys, type Principal } from "./core/auth.js";
import { UserError } from "./core/errors.js";
import type { Service } from "./core/service.js";
import { createMcpServer } from "./mcp/tools.js";
import { confirmationCode, deletionStatusHtml, esc, parseSignedRequest, privacyHtml } from "./web/privacy.js";

export const VERSION = "0.1.0";

export interface AppCtx {
  app: Hono<{ Variables: { who: Principal } }>;
  /** Resolves when queued webhook processing has finished (tests, graceful shutdown). */
  idle(): Promise<void>;
  stats: { webhookRejected: number; webhookAccepted: number };
}

/** Fixed-window per-key rate limiter (in memory; single process). */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    return ++h.n <= perMinute;
  };
}

export function createApp(svc: Service, opts: { rateLimitPerMin?: number } = {}): AppCtx {
  const app = new Hono<{ Variables: { who: Principal } }>();
  const keys = new Keys(svc.db);
  const cfg = svc.config;
  const pending = new Set<Promise<unknown>>();
  const stats = { webhookRejected: 0, webhookAccepted: 0 };
  const allow = rateLimiter(opts.rateLimitPerMin ?? 300);
  const meta = svc.connector("ig") as MetaConnector | undefined;

  app.onError((e, c) => {
    if (e instanceof UserError) return c.json({ err: e.message }, e.status as never);
    svc.log.error({ err: e.message, path: c.req.path }, "unhandled");
    return c.json({ err: "internal error" }, 500);
  });

  // ---- public ---------------------------------------------------------------
  app.get("/healthz", (c) => c.json({ ok: true, v: VERSION }));
  app.get("/privacy", (c) => c.html(privacyHtml(cfg.publicUrl, process.env.PRIVACY_CONTACT ?? "See the account owner's profile.")));

  app.post("/data-deletion", async (c) => {
    if (!cfg.meta.appSecret) return c.json({ err: "not configured" }, 503);
    const form = await c.req.parseBody();
    const data = parseSignedRequest(String(form.signed_request ?? ""), cfg.meta.appSecret);
    if (!data?.user_id) return c.json({ err: "invalid signed_request" }, 400);
    const n = svc.store.forgetPerson("ig", String(data.user_id));
    const code = confirmationCode();
    svc.db.prepare("INSERT INTO deletions (code, subject, n, ts) VALUES (?, ?, ?, ?)").run(code, "meta-user", n, Date.now());
    svc.store.audit("meta", "data_deletion", code, { n });
    return c.json({ url: `${cfg.publicUrl}/data-deletion?code=${code}`, confirmation_code: code });
  });
  app.get("/data-deletion", (c) => {
    const code = c.req.query("code") ?? "";
    const row = svc.db.prepare("SELECT n, ts FROM deletions WHERE code = ?").get(code) as { n: number; ts: number } | undefined;
    return c.html(deletionStatusHtml(code, row), row ? 200 : 404);
  });

  app.get("/webhooks/meta", (c) => {
    if (!cfg.meta.webhooksEnabled) return c.text("disabled", 404);
    const challenge = verifyChallenge(new URL(c.req.url).searchParams, cfg.meta.webhookVerifyToken);
    return challenge ? c.text(challenge) : c.text("forbidden", 403);
  });

  app.post("/webhooks/meta", async (c) => {
    if (!cfg.meta.webhooksEnabled) return c.text("disabled", 404);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!cfg.meta.appSecret || !verifySignature(raw, c.req.header("x-hub-signature-256"), cfg.meta.appSecret)) {
      stats.webhookRejected++; // count only; never log bodies
      return c.text("invalid signature", 401);
    }
    stats.webhookAccepted++;
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return c.text("bad json", 400);
    }
    // Ack immediately; process after the response.
    const job = (async () => {
      if (!meta) return;
      const { items, ignored } = await meta.webhookItems(payload);
      const r = svc.store.ingest(items);
      svc.log.info({ new: r.new, upd: r.updated, ignored }, "webhook ingested");
    })()
      .catch((e) => svc.log.error({ err: (e as Error).message }, "webhook processing failed"))
      .finally(() => pending.delete(job));
    pending.add(job);
    return c.text("ok");
  });

  app.get("/oauth/meta/callback", async (c) => {
    const q = c.req.query();
    if (!consumeState(svc.db, q.state)) return c.html("<p>Invalid or expired login state. Start again with <code>sinbox connect meta</code>.</p>", 400);
    if (q.error || !q.code) return c.html(`<p>Login cancelled: ${esc(q.error_description ?? q.error ?? "no code")}</p>`, 400);
    if (!meta) return c.html("<p>Instagram connector disabled.</p>", 503);
    const acct = await completeLogin(svc.db, cfg, meta.graph, q.code);
    meta.resetAccountCache();
    svc.store.audit("oauth", "connect", "ig", { ig: acct.igUserId, page: acct.pageId });
    return c.html(`<p>Connected <b>@${esc(acct.username)}</b> (Page ${esc(acct.pageId)}). You can close this tab.</p>`);
  });

  // ---- authenticated ------------------------------------------------------------
  const auth = async (c: Context<{ Variables: { who: Principal } }>, next: () => Promise<void>) => {
    const who = keys.verify(bearer(c.req.header("authorization")));
    if (!who) return c.json({ err: "unauthorized" }, 401);
    if (!allow(who.name)) return c.json({ err: "rate limited" }, 429);
    c.set("who", who);
    await next();
  };

  app.use("/api/*", auth);
  app.route("/api", apiRoutes(svc));

  // MCP over Streamable HTTP, stateless: one server + transport per request keeps memory flat.
  app.use("/mcp", auth);
  app.all("/mcp", async (c) => {
    const server = createMcpServer(svc, c.get("who"), VERSION);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  return {
    app,
    stats,
    idle: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
