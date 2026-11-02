import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeEmailProvider } from "../src/automations/email.js";
import { igMessage } from "../src/connectors/meta/index.js";
import type { DraftRow } from "../src/core/types.js";
import { APP_SECRET, fixture, igRoutes, metaSetup } from "./helpers.js";

const sign = (body: string, secret = APP_SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function deliver(app: ReturnType<typeof metaSetup>["app"], payload: unknown, sig?: string) {
  const body = JSON.stringify(payload);
  return app.request("/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig ?? sign(body) },
    body,
  });
}

const CLAUDE_COMMENT = {
  id: "17900000000000020",
  text: "Claude!",
  timestamp: "2026-10-31T11:58:20+0000",
  username: "tester_two",
  from: { id: "6000000000000006", username: "tester_two" },
};

function setup(env: Record<string, string> = {}, extraRoutes: ReturnType<typeof igRoutes> = []) {
  const plunk = new FakeEmailProvider("plunk");
  const s = metaSetup({ AUTOMATIONS_ENABLED: "true", ...env }, [...extraRoutes, ...igRoutes()], { email: { plunk } });
  const drafts = () => s.db.prepare("SELECT * FROM drafts ORDER BY rowid").all() as DraftRow[];
  const posts = () => s.graph.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
  return { ...s, plunk, drafts, posts };
}

const flow = {
  name: "Claude reel",
  enabled: true,
  trigger: { type: "comment_keyword", keywords: ["claude"], media_ids: ["18000000000000001"] },
  steps: [
    { type: "private_reply", text: "Hej! Kliknij, a wyślę przewodnik.", button: { title: "Wyślij", payload: "GUIDE" } },
    { type: "ask_email", text: "Na jaki email?" },
    { type: "push_email", provider: "plunk" },
  ],
};

describe("Meta webhooks for automations", () => {
  it("parses postbacks, quick replies, story replies and story mentions", async () => {
    const { meta } = setup();
    const pb = await meta.webhookItems(fixture("webhook_postback"));
    expect(pb.items).toHaveLength(1);
    expect(pb.items[0]).toMatchObject({ src: "ig.dm", threadNativeId: "dm:6000000000000006", authorId: "6000000000000006", text: "[tap] Wyślij", me: false });
    expect((pb.items[0]!.raw as { postback: { payload: string } }).postback.payload).toBe("GUIDE");

    const { items } = await meta.webhookItems(fixture("webhook_qr_story"));
    expect(items.map((i) => i.text)).toEqual(["Claude", "poproszę link", "[story reply/mention]"]);
    expect((items[0]!.raw as { message: { quick_reply: { payload: string } } }).message.quick_reply.payload).toBe("Q_CLAUDE");
    expect((items[1]!.raw as { story: unknown }).story).toEqual({ reply_to: { id: "17950000000000001", link: "https://lookaside.example.test/story1" } });
    expect((items[2]!.raw as { story: unknown }).story).toEqual({ mention: { id: undefined, link: "https://lookaside.example.test/story2" } });
  });

  it("still rejects bad signatures with 401 and ingests nothing", async () => {
    const { app, svc, idle, stats } = setup();
    svc.flows.upsert(flow, "test", true);
    expect((await deliver(app, fixture("webhook_comment_claude"), sign("tampered"))).status).toBe(401);
    await idle();
    expect(stats.webhookRejected).toBe(1);
    expect(svc.db.prepare("SELECT count(*) AS n FROM items").get()).toEqual({ n: 0 });
  });

  it("end to end: webhook comment → one private reply with a button, poll duplicate ignored, tap → ask_email → push", async () => {
    const { app, svc, idle, drafts, posts, plunk, graph } = setup({ META_HUMAN_AGENT: "true" }, [["GET", /^18000000000000001\/comments$/, () => ({ data: [CLAUDE_COMMENT] })]]);
    svc.flows.upsert(flow, "test", true);

    expect((await deliver(app, fixture("webhook_comment_claude"))).status).toBe(200);
    await idle();
    // same comment again via webhook redelivery and via the poller
    await deliver(app, fixture("webhook_comment_claude"));
    await idle();
    await svc.sync({ src: "ig.cm" });
    const pr = drafts().filter((d) => d.kind === "private_reply");
    expect(pr).toHaveLength(1);
    expect(graph.calls.some((c) => c.path === "18000000000000001/comments")).toBe(true);

    // human approves; Graph gets a button template on the private reply
    svc.approve(pr[0]!.id, "human");
    await svc.sendApproved(pr[0]!.id, "human");
    expect(posts()[0]!.body).toEqual({
      recipient: { comment_id: "17900000000000020" },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "button", text: "Hej! Kliknij, a wyślę przewodnik.", buttons: [{ type: "postback", title: "Wyślij", payload: "GUIDE" }] },
        },
      },
    });

    // the tap arrives as messaging_postbacks and opens the DM step
    await deliver(app, fixture("webhook_postback"));
    await idle();
    const ask = drafts().find((d) => d.kind === "dm")!;
    expect(ask.text).toBe("Na jaki email?");
    svc.approve(ask.id, "human");
    await svc.sendApproved(ask.id, "human");
    // RESPONSE inside the 24 h window; never the HUMAN_AGENT tag for automations
    expect(posts()[1]!.body).toEqual({ recipient: { id: "6000000000000006" }, message: { text: "Na jaki email?" }, messaging_type: "RESPONSE" });

    const reply = {
      object: "instagram",
      entry: [
        {
          id: "17841400000000001",
          time: 1793447990000,
          messaging: [{ sender: { id: "6000000000000006" }, recipient: { id: "17841400000000001" }, timestamp: 1793447990000, message: { mid: "aWdfEMAIL1", text: "tester@example.test" } }],
        },
      ],
    };
    await deliver(app, reply);
    await idle();
    expect(plunk.pushed.map((p) => [p.email, p.source.media])).toEqual([["tester@example.test", "18000000000000001"]]);
  });

  it("sends quick replies and link buttons in the Graph message format", () => {
    expect(igMessage("Który?", JSON.stringify({ quick_replies: [{ title: "Claude", payload: "Q1" }] }))).toEqual({
      text: "Który?",
      quick_replies: [{ content_type: "text", title: "Claude", payload: "Q1" }],
    });
    expect(igMessage("Link", JSON.stringify({ buttons: [{ title: "Otwórz", url: "https://wozu.co/x?utm_source=ig" }] }))).toEqual({
      attachment: { type: "template", payload: { template_type: "button", text: "Link", buttons: [{ type: "web_url", url: "https://wozu.co/x?utm_source=ig", title: "Otwórz" }] } },
    });
    expect(igMessage("plain", null)).toEqual({ text: "plain" });
  });

  it("webhook quick replies and stories trigger flows", async () => {
    const { app, svc, idle, drafts } = setup();
    const dm = (text: string) => [{ type: "send_dm", text }];
    svc.flows.upsert({ name: "qr", enabled: true, trigger: { type: "postback", payload: "Q_CLAUDE" }, steps: dm("qr ok") }, "test", true);
    svc.flows.upsert({ name: "sr", enabled: true, trigger: { type: "story_reply", keywords: ["link"] }, steps: dm("sr ok") }, "test", true);
    svc.flows.upsert({ name: "sm", enabled: true, trigger: { type: "story_mention" }, steps: dm("sm ok") }, "test", true);
    await deliver(app, fixture("webhook_qr_story"));
    await idle();
    expect(drafts().map((d) => d.text)).toEqual(["qr ok", "sr ok", "sm ok"]);
  });

  it("polled messages carry story info for story triggers", async () => {
    const storyMsg = {
      id: "aWdfZAG1STORYPOLL1",
      created_time: "2026-10-31T11:59:00+0000",
      from: { id: "6000000000000001", username: "ania_k" },
      message: "Link?",
      story: { reply_to: { id: "17950000000000003", link: "https://lookaside.example.test/story3" } },
    };
    const { svc, drafts } = setup({}, [["GET", /AAAA1\/messages$/, () => ({ data: [storyMsg] })]]);
    svc.flows.upsert({ name: "sr", enabled: true, trigger: { type: "story_reply" }, steps: [{ type: "send_dm", text: "Tu link" }] }, "test", true);
    await svc.sync({ src: "ig.dm" });
    expect(drafts().map((d) => [d.text, d.status])).toEqual([["Tu link", "pending"]]);
    expect(svc.db.prepare("SELECT media_id FROM flow_events WHERE type = 'triggered'").all()).toEqual([{ media_id: "17950000000000003" }]);
  });
});
