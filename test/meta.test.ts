import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAccount } from "../src/connectors/meta/account.js";
import { verifySignature } from "../src/connectors/meta/webhook.js";
import { APP_SECRET, ENC_KEY, IG, fixture, igRoutes, metaSetup, NOW } from "./helpers.js";

const sign = (body: string, secret = APP_SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function deliver(app: ReturnType<typeof metaSetup>["app"], payload: unknown, sig?: string) {
  const body = JSON.stringify(payload);
  return app.request("/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig ?? sign(body) },
    body,
  });
}

const rows = (r: unknown) => {
  const t = r as { cols: string[]; rows: unknown[][] };
  return t.rows.map((row) => Object.fromEntries(t.cols.map((c, i) => [c, row[i]])));
};

describe("Instagram polling (fixtures)", () => {
  it("ingests the last 30 days of conversations, comments and tags", async () => {
    const { svc } = metaSetup();
    const r = await svc.sync();
    // 3 + 1 DMs (conv1, conv2), 3 comments incl. wozu's reply, 1 tag
    expect(r.ig).toEqual({ new: 8, upd: 0 });
    const items = rows(svc.list({ unread: false, limit: 50, fields: ["src", "who", "x", "me", "on", "win"] }));

    // conv3 is from August: outside the 30-day backfill
    expect(items.some((i) => i.who === "@old_friend")).toBe(false);
    const dms = items.filter((i) => i.src === "ig.dm");
    expect(dms.map((i) => i.x).sort()).toEqual(
      ["Cześć! Dzięki za wiadomość.", "Hej! Ile kosztuje minikurs i czy jest dla początkujących?", "Hi, are you open to a paid collab next month?", "[image]"].sort(),
    );
    expect(dms.find((i) => i.who === "@ania_k" && String(i.x).startsWith("Hej"))?.win).toBe("23h");
    expect(dms.find((i) => i.who === "@marek.p")?.win).toBe("closed");
    expect(dms.find((i) => i.me === 1)?.who).toBe("me");

    const cms = items.filter((i) => i.src === "ig.cm");
    expect(cms).toHaveLength(3);
    expect(cms.every((i) => i.on === "post:p1")).toBe(true);
    expect(items.find((i) => i.src === "ig.mn")).toMatchObject({ who: "@julia.design" });

    // labels: spam comment is triaged
    const spam = rows(svc.list({ lbl: "spam" }));
    expect(spam).toHaveLength(1);
  });

  it("is idempotent across polls and only refetches comments when counts change", async () => {
    const { svc, graph, clock } = metaSetup();
    await svc.sync();
    const commentCalls = () => graph.calls.filter((c) => c.path.endsWith("/comments")).length;
    expect(commentCalls()).toBe(1);
    clock.t += 5 * 60_000;
    const again = await svc.sync({ force: true });
    expect(again.ig).toEqual({ new: 0, upd: 0 });
    expect(commentCalls()).toBe(1);
  });

  it("threads comment replies under the top-level comment and marks it answered", async () => {
    const { svc } = metaSetup();
    await svc.sync();
    const kasia = rows(svc.list({ unread: false, q: "efekt" }))[0]!;
    const t = svc.threadGet({ t: kasia.t as string });
    expect(t.msgs).toMatchObject({ cols: ["id", "who", "age", "x", "me"] });
    expect((t.msgs as { rows: unknown[] }).rows).toHaveLength(2);
    expect(t.sum).toBe("1 in/1 out, last in 24h");
    // wozu already replied, so the comment is not unread
    expect(rows(svc.list({ q: "efekt" }))).toHaveLength(0);
  });

  it("sends appsecret_proof with every Graph call", async () => {
    const { svc, graph } = metaSetup();
    await svc.sync();
    const proof = createHmac("sha256", APP_SECRET).update(IG.pageToken).digest("hex");
    expect(graph.calls.every((c) => c.params.appsecret_proof === proof)).toBe(true);
  });
});

describe("Instagram webhooks", () => {
  it("verifies the subscription handshake", async () => {
    const { app } = metaSetup();
    const ok = await app.request("/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify_me&hub.challenge=42");
    expect(await ok.text()).toBe("42");
    const bad = await app.request("/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(bad.status).toBe(403);
  });

  it("rejects invalid or missing signatures with 401 and ingests nothing", async () => {
    const { app, svc, stats } = metaSetup();
    expect((await deliver(app, fixture("webhook_dm"), sign("other body"))).status).toBe(401);
    expect((await deliver(app, fixture("webhook_dm"), "sha256=deadbeef")).status).toBe(401);
    const noSig = await app.request("/webhooks/meta", { method: "POST", body: JSON.stringify(fixture("webhook_dm")) });
    expect(noSig.status).toBe(401);
    expect(stats.webhookRejected).toBe(3);
    expect(svc.overview().unread).toEqual({});
  });

  it("is disabled unless META_WEBHOOKS_ENABLED=true", async () => {
    const { app } = metaSetup({ META_WEBHOOKS_ENABLED: "false" });
    expect((await deliver(app, fixture("webhook_dm"))).status).toBe(404);
  });

  it("ingests a tester DM, resolves the username, and dedupes with polling", async () => {
    const { app, svc, idle } = metaSetup();
    const res = await deliver(app, fixture("webhook_dm"));
    expect(res.status).toBe(200);
    await idle();
    const dm = rows(svc.list({ src: "ig.dm" }));
    expect(dm).toEqual([expect.objectContaining({ who: "@tester_one", x: "Test DM from the tester account", win: "23h" })]);
    // same delivery again (Meta retries) → no duplicate
    await deliver(app, fixture("webhook_dm"));
    await idle();
    expect(rows(svc.list({ src: "ig.dm" }))).toHaveLength(1);
  });

  it("ingests comments and fetches mention details", async () => {
    const { app, svc, idle } = metaSetup();
    await deliver(app, fixture("webhook_comment"));
    await idle();
    const items = rows(svc.list({ fields: ["src", "who", "x", "on"] }));
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "ig.cm", who: "@tester_two", x: "Webhook comment: ile kosztuje kurs?", on: "post:p1" }),
        expect.objectContaining({ src: "ig.mn", who: "@tester_two", x: "@wozu_co sprawdź to" }),
      ]),
    );
  });

  it("signature check works on raw bytes", () => {
    const raw = Buffer.from('{"a":"ł"}');
    expect(verifySignature(raw, sign(raw.toString()), APP_SECRET)).toBe(true);
    expect(verifySignature(raw, sign(raw.toString(), "x"), APP_SECRET)).toBe(false);
    expect(verifySignature(raw, undefined, APP_SECRET)).toBe(false);
  });
});

describe("Instagram drafts → approval → send (M1 acceptance, mocked Graph)", () => {
  it("a tester DM can be replied to after approval", async () => {
    const { app, svc, graph, idle } = metaSetup();
    await deliver(app, fixture("webhook_dm"));
    await idle();
    const d = svc.draftReply({ to: "i1", text: "Hej! Dzięki za wiadomość." }, "mcp:agent");
    expect(d.checks).toEqual(["win 23h", "len 25/1000"]);
    await expect(svc.sendApproved(d.d!, "mcp:agent")).rejects.toThrow(/not approved/);
    expect(graph.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    svc.approve(d.d!, "api:admin");
    const sent = await svc.sendApproved(d.d!, "mcp:agent");
    expect(sent).toMatchObject({ st: "sent", nid: "aWdfZAG1sent1" });
    const post = graph.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(`${IG.pageId}/messages`);
    expect(post.body).toEqual({ recipient: { id: "6000000000000005" }, message: { text: "Hej! Dzięki za wiadomość." }, messaging_type: "RESPONSE" });

    // outbound message lands in the thread; inbound is now read
    const t = svc.threadGet({ t: "t1" });
    expect((t.msgs as { rows: unknown[][] }).rows.at(-1)).toEqual(["i2", "1m", "Hej! Dzięki za wiadomość.", 1]);
    expect(svc.overview().unread).toEqual({});
  });

  it("refuses a DM draft outside the 24h window with a clear reason", async () => {
    const { svc } = metaSetup();
    await svc.sync();
    const marek = rows(svc.list({ src: "ig.dm", fields: ["who"] })).find((r) => r.who === "@marek.p")!;
    expect(() => svc.draftReply({ to: marek.id as string, text: "Hej!" }, "agent")).toThrow(
      "reply window closed: last message from @marek.p was 2d ago (limit 24h)",
    );
  });

  it("uses HUMAN_AGENT within 7 days only when the flag is on", async () => {
    const { svc, graph } = metaSetup({ META_HUMAN_AGENT: "true" });
    await svc.sync();
    const marek = rows(svc.list({ src: "ig.dm", fields: ["who"] })).find((r) => r.who === "@marek.p")!;
    const d = svc.draftReply({ to: marek.id as string, text: "Sorry for the delay!" }, "agent");
    expect((d.checks as string[])[0]).toMatch(/^win \d+d HA$/);
    svc.approve(d.d!, "human");
    await svc.sendApproved(d.d!, "agent");
    expect(graph.calls.find((c) => c.method === "POST")!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("a comment can be replied to and hidden after approval", async () => {
    const { svc, graph } = metaSetup();
    await svc.sync();
    const spam = rows(svc.list({ lbl: "spam" }))[0]!;
    const kasia = rows(svc.list({ unread: false, q: "efekt" }))[0]!;

    const reply = svc.draftReply({ to: kasia.id as string, text: "Opisałem to w stories 🙂" }, "agent");
    const hide = svc.draftModeration({ id: spam.id as string, action: "hide" }, "agent");
    for (const d of [reply.d!, hide.d!]) svc.approve(d, "human");
    await svc.sendApproved(reply.d!, "agent");
    await svc.sendApproved(hide.d!, "agent");

    const posts = graph.calls.filter((c) => c.method === "POST");
    expect(posts[0]).toMatchObject({ path: "17900000000000001/replies", params: { message: "Opisałem to w stories 🙂" } });
    expect(posts[1]).toMatchObject({ path: "17900000000000003", params: { hide: "true" } });
    expect(svc.itemGet({ id: spam.id as string }).x).toMatch(/\[hidden\]$/);
  });

  it("deletes a comment and sends a private reply after approval", async () => {
    const { svc, graph } = metaSetup();
    await svc.sync();
    const spam = rows(svc.list({ lbl: "spam" }))[0]!;
    const del = svc.draftModeration({ id: spam.id as string, action: "delete" }, "agent");
    const pr = svc.draftReply({ to: spam.id as string, text: "Napisz proszę na priv", kind: "private_reply" }, "agent");
    svc.approve(del.d!, "human");
    svc.approve(pr.d!, "human");
    await svc.sendApproved(pr.d!, "agent");
    await svc.sendApproved(del.d!, "agent");
    expect(graph.calls.find((c) => c.method === "POST")!.body).toEqual({
      recipient: { comment_id: "17900000000000003" },
      message: { text: "Napisz proszę na priv" },
    });
    expect(graph.calls.find((c) => c.method === "DELETE")!.path).toBe("17900000000000003");
    expect(rows(svc.list({ unread: false, lbl: "spam" }))).toHaveLength(0);
  });

  it("rejects YouTube-only moderation on Instagram", async () => {
    const { svc } = metaSetup();
    await svc.sync();
    const c = rows(svc.list({ src: "ig.cm" }))[0]!;
    expect(() => svc.draftModeration({ id: c.id as string, action: "reject" }, "agent")).toThrow(/not supported/);
  });

  it("surfaces permanent Graph errors as failed drafts without retry", async () => {
    const routes = igRoutes();
    routes.unshift(["POST", /\/replies$/, () => new Response(JSON.stringify({ error: { message: "(#10) Permission denied", code: 10 } }), { status: 403 })]);
    const { svc } = metaSetup({}, routes);
    await svc.sync();
    const c = rows(svc.list({ src: "ig.cm" }))[0]!;
    const d = svc.draftReply({ to: c.id as string, text: "x" }, "agent").d!;
    svc.approve(d, "human");
    expect(await svc.sendApproved(d, "agent")).toMatchObject({ st: "failed", err: expect.stringMatching(/code 10/) });
  });
});

describe("Meta OAuth + privacy endpoints", () => {
  it("runs the Facebook Login for Business flow with single-use state and stores the Page token encrypted", async () => {
    const routes = igRoutes();
    routes.unshift(
      ["GET", /^oauth\/access_token$/, (c) => (c.params.code ? { access_token: "short" } : { access_token: "long_user", expires_in: 5_184_000 })],
      ["GET", /^me\/accounts$/, () => ({
        data: [
          { id: "999", name: "Other page", access_token: "EAAother" },
          { id: "100000000000002", name: "wozu", access_token: "EAAnewpage", instagram_business_account: { id: "17841400000000002", username: "wozu_co" } },
        ],
      })],
    );
    const { app, db, svc } = metaSetup({}, routes);
    const start = await app.request("/api/oauth/meta/start", { method: "POST", headers: { authorization: "Bearer sk_test_admin" } });
    const { url } = (await start.json()) as { url: string };
    const u = new URL(url);
    expect(u.searchParams.get("redirect_uri")).toBe("https://inbox.example.test/oauth/meta/callback");
    expect(u.searchParams.get("scope")).toBe(
      "instagram_basic,instagram_manage_messages,instagram_manage_comments,pages_show_list,pages_read_engagement,pages_manage_metadata",
    );
    const state = u.searchParams.get("state")!;

    expect((await app.request(`/oauth/meta/callback?code=abc&state=forged`)).status).toBe(400);
    const cb = await app.request(`/oauth/meta/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("@wozu_co");
    expect((await app.request(`/oauth/meta/callback?code=abc&state=${state}`)).status).toBe(400); // replay

    const acct = loadAccount(db, ENC_KEY)!;
    expect(acct).toMatchObject({ igUserId: "17841400000000002", pageId: "100000000000002", pageToken: "EAAnewpage" });
    const raw = db.prepare("SELECT enc FROM tokens WHERE kind = 'page'").get() as { enc: string };
    expect(raw.enc).not.toContain("EAAnewpage");
    expect(svc.db.prepare("SELECT count(*) AS n FROM audit WHERE action = 'connect'").get()).toEqual({ n: 1 });
  });

  it("handles Meta data-deletion callbacks with verified signed_request", async () => {
    const { app, svc } = metaSetup();
    await svc.sync();
    const before = svc.store.exportPerson("ig", "6000000000000001").length;
    expect(before).toBe(3);
    const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "6000000000000001", issued_at: NOW / 1000 })).toString("base64url");
    const sig = createHmac("sha256", APP_SECRET).update(payload).digest("base64url");

    const bad = await app.request("/data-deletion", { method: "POST", body: new URLSearchParams({ signed_request: `xx.${payload}` }) });
    expect(bad.status).toBe(400);

    const res = await app.request("/data-deletion", { method: "POST", body: new URLSearchParams({ signed_request: `${sig}.${payload}` }) });
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.url).toContain(body.confirmation_code);
    expect(svc.store.exportPerson("ig", "6000000000000001")).toHaveLength(0);
    const status = await app.request(`/data-deletion?code=${body.confirmation_code}`);
    expect(await status.text()).toContain("Deletion complete");
  });
});
