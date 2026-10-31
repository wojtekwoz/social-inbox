import { Hono, type Context } from "hono";
import * as F from "../automations/api.js";
import type { Principal, Scope } from "../core/auth.js";
import { UserError } from "../core/errors.js";
import * as S from "../core/schemas.js";
import type { Service } from "../core/service.js";
import { loginUrl } from "../connectors/meta/oauth.js";

// REST mirrors the MCP tools. Query strings are coerced to the same shapes the tools use.

type Env = { Variables: { who: Principal } };

const LIST_KEYS = new Set(["src", "lbl", "fields"]);
const NUM_KEYS = new Set(["limit", "maxChars", "last"]);
const BOOL_KEYS = new Set(["unread", "full", "summary"]);

function query(c: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URL(c.req.url).searchParams) {
    if (LIST_KEYS.has(k)) out[k] = v.split(",").filter(Boolean);
    else if (NUM_KEYS.has(k)) out[k] = Number(v);
    else if (BOOL_KEYS.has(k)) out[k] = v === "1" || v === "true";
    else out[k] = v;
  }
  return out;
}

const parse = <Sh extends S.Shape>(shape: Sh, v: unknown): S.In<Sh> => {
  const r = S.obj(shape).safeParse(v);
  if (!r.success) throw new UserError(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data as S.In<Sh>;
};

const body = async (c: Context) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};

export function apiRoutes(svc: Service): Hono<Env> {
  const api = new Hono<Env>();
  const need = (c: Context<Env>, scope: Scope) => {
    if (!c.get("who").scopes.has(scope)) throw new UserError(`key lacks scope "${scope}"`, 403);
    return `api:${c.get("who").name}`;
  };

  api.get("/overview", (c) => (need(c, "read"), c.json(svc.overview())));
  api.get("/items", (c) => (need(c, "read"), c.json(svc.list(parse(S.listShape, query(c))))));
  api.get("/items/:id", (c) => (need(c, "read"), c.json(svc.itemGet(parse(S.itemShape, { ...query(c), id: c.req.param("id") })))));
  api.get("/threads/:t", (c) => (need(c, "read"), c.json(svc.threadGet(parse(S.threadShape, { ...query(c), t: c.req.param("t") })))));
  api.put("/threads/:t/note", async (c) => {
    const actor = need(c, "draft");
    return c.json(svc.threadNote(parse(S.noteShape, { ...(await body(c)), t: c.req.param("t") }), actor));
  });
  api.get("/search", (c) => (need(c, "read"), c.json(svc.search(parse(S.searchShape, query(c))))));
  api.post("/mark", async (c) => {
    const actor = need(c, "draft");
    return c.json(svc.mark(parse(S.markShape, await body(c)), actor));
  });

  api.get("/drafts", (c) => (need(c, "read"), c.json(svc.drafts(parse(S.draftsShape, query(c))))));
  api.get("/drafts/:d", (c) => (need(c, "read"), c.json(svc.draftGet(c.req.param("d")))));
  api.post("/drafts", async (c) => {
    const actor = need(c, "draft");
    return c.json(svc.draftReply(parse(S.draftReplyShape, await body(c)), actor), 201);
  });
  api.post("/drafts/moderation", async (c) => {
    const actor = need(c, "draft");
    return c.json(svc.draftModeration(parse(S.draftModerationShape, await body(c)), actor), 201);
  });
  api.patch("/drafts/:d", async (c) => {
    const actor = need(c, "draft");
    const b = (await body(c)) as { text?: unknown };
    if (typeof b.text !== "string" || !b.text.trim()) throw new UserError("text required");
    return c.json(svc.editDraft(c.req.param("d"), b.text, actor));
  });
  // Human-only: needs a key with the `approve` scope (the default agent key does not have it).
  api.post("/drafts/:d/approve", async (c) => {
    const actor = need(c, "approve");
    const res = svc.approve(c.req.param("d"), actor);
    if (c.req.query("send") === "1") return c.json({ ...res, send: await svc.sendApproved(c.req.param("d"), actor) });
    return c.json(res);
  });
  api.post("/drafts/:d/reject", (c) => {
    const actor = need(c, "approve");
    return c.json(svc.reject(c.req.param("d"), actor));
  });
  api.post("/drafts/:d/send", async (c) => {
    const actor = need(c, "send");
    return c.json(await svc.sendApproved(c.req.param("d"), actor));
  });
  api.post("/sync", async (c) => {
    need(c, "read");
    return c.json(await svc.sync(parse(S.syncShape, await body(c)) as never));
  });
  // ---- automations
  const canApprove = (c: Context<Env>) => c.get("who").scopes.has("approve");
  api.get("/flows", (c) => (need(c, "read"), c.json(svc.flows.list())));
  api.get("/flows/metrics", (c) => {
    need(c, "read");
    const q = query(c);
    return c.json(svc.flows.metrics(parse(F.flowMetricsShape, { id: q.id, days: q.days === undefined ? undefined : Number(q.days) })));
  });
  api.get("/flows/:f", (c) => (need(c, "read"), c.json(svc.flows.flowGet(parse(F.flowGetShape, { id: c.req.param("f") })))));
  api.post("/flows", async (c) => {
    const actor = need(c, "draft");
    const res = svc.flows.upsert(await body(c), actor, canApprove(c));
    return c.json(res, res.created ? 201 : 200);
  });
  api.put("/flows/:f", async (c) => {
    const actor = need(c, "draft");
    return c.json(svc.flows.upsert({ ...(await body(c)), id: c.req.param("f") }, actor, canApprove(c)));
  });
  for (const [path, on] of [["on", true], ["off", false]] as const)
    api.post(`/flows/:f/${path}`, (c) => {
      const actor = need(c, "draft");
      return c.json(svc.flows.toggle(parse(F.flowToggleShape, { id: c.req.param("f"), on }), actor, canApprove(c)));
    });
  api.post("/flows/:f/test", async (c) => {
    need(c, "read");
    return c.json(svc.flows.test(parse(F.flowTestShape, { ...(await body(c)), id: c.req.param("f") })));
  });

  api.post("/oauth/meta/start", (c) => {
    need(c, "approve");
    return c.json({ url: loginUrl(svc.db, svc.config) });
  });
  return api;
}
