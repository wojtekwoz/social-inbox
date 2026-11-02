import { describe, expect, it } from "vitest";
import { FakeEmailProvider } from "../src/automations/email.js";
import { D, H } from "../src/core/time.js";
import type { DraftRow, IncomingItem } from "../src/core/types.js";
import { fakeSetup } from "./helpers.js";

const ON = { AUTOMATIONS_ENABLED: "true" };

const leadFlow = (patch: Record<string, unknown> = {}) => ({
  name: "Claude guide",
  enabled: true,
  trigger: { type: "comment_keyword", keywords: ["claude"], media_ids: ["m1"] },
  steps: [
    { type: "private_reply", text: "Hej! Kliknij, a wyślę Ci przewodnik.", button: { title: "Wyślij", payload: "GUIDE" } },
    { type: "public_reply", variants: ["Sprawdź DM 📩", "Wysłane!"] },
    { type: "ask_email", text: "Na jaki email wysłać przewodnik?", retry_text: "To nie wygląda na email, spróbuj jeszcze raz." },
    { type: "push_email", provider: "plunk", tags: ["claude"] },
    { type: "tag", label: "lead" },
  ],
  ...patch,
});

function setup(env: Record<string, string> = {}) {
  const plunk = new FakeEmailProvider("plunk");
  const s = fakeSetup({ ...ON, ...env }, { email: { plunk } });
  const t = s.clock;
  let n = 0;
  const dm = (text: string, o: { uid?: string; ts?: number; raw?: unknown; nid?: string } = {}): IncomingItem => ({
    net: "fake",
    nativeId: o.nid ?? `dm${++n}`,
    src: "ig.dm",
    threadNativeId: `dm:${o.uid ?? "u9"}`,
    authorId: o.uid ?? "u9",
    who: "@fan",
    text,
    ts: o.ts ?? t.t - 30_000,
    raw: o.raw,
  });
  const h = {
    ...s,
    plunk,
    flow: (f: Record<string, unknown> = leadFlow()) => s.svc.flows.upsert(f, "test", true).f as string,
    comment: (text: string, o: { uid?: string; ts?: number; media?: string; nid?: string } = {}): IncomingItem => {
      const nid = o.nid ?? `c${++n}`;
      return { net: "fake", nativeId: nid, src: "ig.cm", threadNativeId: nid, authorId: o.uid ?? "u9", who: "@fan", text, ts: o.ts ?? t.t - 60_000, post: { nativeId: o.media ?? "m1" } };
    },
    dm,
    tap: (payload: string, o: { uid?: string; ts?: number } = {}): IncomingItem => dm("[tap] Wyślij", { ...o, raw: { postback: { payload, title: "Wyślij" } } }),
    drafts: () => s.db.prepare("SELECT * FROM drafts ORDER BY rowid").all() as DraftRow[],
    events: (type?: string) =>
      (s.db.prepare("SELECT type, reason, step FROM flow_events ORDER BY id").all() as { type: string; reason: string | null; step: number | null }[]).filter(
        (e) => !type || e.type === type,
      ),
    runs: () => s.db.prepare("SELECT id, state, step, vars FROM flow_runs ORDER BY rowid").all() as { id: string; state: string; step: number; vars: string }[],
  };
  return h;
}

describe("acceptance 1: comment keyword → one private reply", () => {
  it("a 'Claude!' comment creates exactly one private-reply draft with one button; duplicates create nothing", async () => {
    const h = setup();
    const f = h.flow();
    const c = h.comment("CLAUDÉ!!");
    await h.svc.ingest([c]);

    const pr = h.drafts().filter((d) => d.kind === "private_reply");
    expect(pr).toHaveLength(1);
    expect(pr[0]!.status).toBe("pending");
    expect(pr[0]!.created_by).toBe("system:automation");
    expect(JSON.parse(pr[0]!.payload!)).toEqual({ buttons: [{ title: "Wyślij", payload: "GUIDE" }], flow: f, step: 0 });
    expect(h.drafts().filter((d) => d.kind === "reply")).toHaveLength(1); // public reply, no tap needed
    expect(h.runs()[0]).toMatchObject({ state: "waiting_input", step: 2 });

    // poll + webhook duplicate of the same comment id, and a re-evaluation of the same item
    const before = h.drafts().length;
    await h.svc.ingest([{ ...c }]);
    await h.svc.ingest([{ ...c, text: "CLAUDÉ!! (edited)" }]);
    await h.svc.automations.evaluate(["i1"]);
    expect(h.drafts()).toHaveLength(before);
    expect(h.events("triggered")).toHaveLength(1);
    // the thread item is labelled as handled by an automation, but stays in the inbox
    expect(h.svc.store.item("i1")!.labels).toContain("auto");
  });

  it("a comment older than 7 days is skipped with a reason", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest([h.comment("claude", { ts: h.clock.t - 8 * D })]);
    expect(h.drafts()).toHaveLength(0);
    expect(h.events()).toEqual([{ type: "skipped", reason: "comment_too_old", step: null }]);
  });

  it("ignores other media, our own comments, and comments from before the flow was switched on", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest([h.comment("claude", { media: "m2" }), { ...h.comment("claude"), me: true }, h.comment("claude", { ts: h.clock.t - 2 * H })]);
    expect(h.drafts()).toHaveLength(0);
    expect(h.events()).toEqual([{ type: "skipped", reason: "before_flow", step: null }]);
  });
});

describe("acceptance 2: button tap → ask_email → push", () => {
  it("a tap within 24h advances to ask_email; a valid email is pushed to the provider and recorded", async () => {
    const h = setup();
    const f = h.flow();
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.ingest([h.tap("GUIDE")]);

    const ask = h.drafts().find((d) => d.kind === "dm")!;
    expect(ask.text).toBe("Na jaki email wysłać przewodnik?");
    expect(h.events("button_tap")).toHaveLength(1);
    expect(h.runs()[0]).toMatchObject({ state: "waiting_input", step: 3 });

    await h.svc.ingest([h.dm("jasne, mój mail: Ania@Example.COM")]);
    expect(h.plunk.pushed).toEqual([{ email: "ania@example.com", tags: ["claude"], group: undefined, event: undefined, source: { channel: "instagram", flow: f, run: "r1", media: "m1" } }]);
    expect(h.events("email_captured")).toHaveLength(1);
    expect(h.events("email_pushed")).toHaveLength(1);
    expect(h.runs()[0]).toMatchObject({ state: "done", step: 5 });
    expect(JSON.parse(h.runs()[0]!.vars).email).toBe("ania@example.com");
    // tag step labelled the DM thread
    expect(h.svc.store.threadItems(ask.thread_id!, 10).every((i) => JSON.parse(i.labels).includes("lead"))).toBe(true);
  });

  it("outside 24h the DM step is skipped with a reason", async () => {
    const h = setup();
    h.flow();
    const t0 = h.clock.t;
    await h.svc.ingest([h.comment("claude")]);
    h.clock.t += 26 * H;
    // the tap only reaches us late (e.g. a poll after downtime): its window is already over
    await h.svc.ingest([h.tap("GUIDE", { ts: t0 + H })]);
    expect(h.drafts().filter((d) => d.kind === "dm")).toHaveLength(0);
    expect(h.events("skipped")).toEqual([{ type: "skipped", reason: "window_closed", step: 2 }]);
    expect(h.runs()[0]!.state).toBe("stopped");
  });

  it("an invalid email gets one retry message, then the run stops", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.ingest([h.tap("GUIDE")]);
    await h.svc.ingest([h.dm("a co to za kurs?")]);
    const dms = h.drafts().filter((d) => d.kind === "dm");
    expect(dms.map((d) => d.text)).toEqual(["Na jaki email wysłać przewodnik?", "To nie wygląda na email, spróbuj jeszcze raz."]);
    await h.svc.ingest([h.dm("nie mam maila")]);
    expect(h.drafts().filter((d) => d.kind === "dm")).toHaveLength(2);
    expect(h.events("skipped")).toEqual([{ type: "skipped", reason: "invalid_email", step: 2 }]);
    expect(h.runs()[0]!.state).toBe("stopped");
    expect(h.plunk.pushed).toHaveLength(0);
  });

  it("does not push when the provider is not configured or sending is off", async () => {
    const h = setup({ SENDING_ENABLED: "false" });
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.ingest([h.tap("GUIDE")]);
    await h.svc.ingest([h.dm("ania@example.pl")]);
    expect(h.plunk.pushed).toHaveLength(0);
    expect(h.events("skipped").map((e) => e.reason)).toEqual(["sending_off"]);

    const h2 = setup();
    h2.flow(leadFlow({ steps: [...leadFlow().steps.slice(0, 3), { type: "push_email", provider: "mailerlite" }] }));
    await h2.svc.ingest([h2.comment("claude")]);
    await h2.svc.ingest([h2.tap("GUIDE")]);
    await h2.svc.ingest([h2.dm("ania@example.pl")]);
    expect(h2.events("skipped").map((e) => e.reason)).toEqual(["email_off"]);
  });
});

describe("acceptance 3: nothing reaches the connector unless every switch is on", () => {
  const autoFlow = () => leadFlow({ mode: "auto" });

  it("defaults (SENDING_ENABLED=false, APPROVAL=human, AUTOMATIONS_AUTOSEND=false): drafts stay pending", async () => {
    const h = setup({ SENDING_ENABLED: "false" });
    expect(h.config.approval).toBe("human");
    expect(h.config.automations.autosend).toBe(false);
    h.flow(autoFlow());
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.retryDue();
    expect(h.drafts().map((d) => d.status)).toEqual(["pending", "pending"]);
    expect(h.fake.sent).toHaveLength(0);
  });

  it("AUTOMATIONS_AUTOSEND without SENDING_ENABLED approves but never executes", async () => {
    const h = setup({ SENDING_ENABLED: "false", AUTOMATIONS_AUTOSEND: "true" });
    h.flow(autoFlow());
    await h.svc.ingest([h.comment("claude")]);
    expect(h.drafts().map((d) => [d.status, d.approved_by])).toEqual([
      ["approved", "system:automation"],
      ["approved", "system:automation"],
    ]);
    expect(h.fake.sent).toHaveLength(0);
  });

  it("with all switches on, a mode:auto flow sends via the fake connector (draft-mode flows still wait)", async () => {
    const h = setup({ SENDING_ENABLED: "true", AUTOMATIONS_AUTOSEND: "true" });
    const f = h.flow(autoFlow());
    h.flow(leadFlow({ name: "draft one", trigger: { type: "comment_keyword", keywords: ["kurs"] } }));
    await h.svc.ingest([h.comment("claude"), h.comment("kurs", { uid: "u8" })]);
    expect(h.fake.sent.map((r) => r.draft.kind)).toEqual(["private_reply", "reply"]);
    expect(JSON.parse(h.fake.sent[0]!.draft.payload!).buttons).toHaveLength(1);
    expect(h.drafts().map((d) => d.status)).toEqual(["sent", "sent", "pending", "pending"]);
    const m = h.svc.flows.metrics({ id: f }) as { cols: string[]; rows: unknown[][] };
    const row = Object.fromEntries(m.cols.map((c, i) => [c, m.rows[0]![i]]));
    expect(row).toMatchObject({ trig: 1, draft: 2, sent: 1, pub: 1 });
  });

  it("automation DMs never use HUMAN_AGENT, even when the feature is on", async () => {
    const h = setup({ META_HUMAN_AGENT: "true" });
    h.flow({ name: "price", enabled: true, trigger: { type: "dm_keyword", keywords: ["cena"] }, steps: [{ type: "send_dm", text: "99 zł" }] });
    await h.svc.ingest([h.dm("cena?")]);
    const d = h.drafts()[0]!;
    h.svc.approve(d.id, "human");
    h.clock.t += 25 * H; // inside the 7-day HUMAN_AGENT window, outside the standard 24 h
    await expect(h.svc.sendApproved(d.id, "human")).rejects.toThrow(/window closed/);
    expect(h.fake.sent).toHaveLength(0);
  });
});

describe("acceptance 4: metrics, policy rejection, unmatched DMs untouched", () => {
  it("flow_metrics counts every event type, with skip reasons and conversion ratios", async () => {
    const h = setup();
    const f = h.flow();
    await h.svc.ingest([h.comment("claude", { uid: "a" }), h.comment("Claude!", { uid: "b" }), h.comment("claude", { uid: "c", ts: h.clock.t - 8 * D })]);
    await h.svc.ingest([h.tap("GUIDE", { uid: "a" })]);
    await h.svc.ingest([h.dm("a@example.pl", { uid: "a" })]);
    const m = h.svc.flows.metrics({ id: f }) as Record<string, unknown> & { cols: string[]; rows: unknown[][] };
    const row = Object.fromEntries(m.cols.map((c, i) => [c, m.rows[0]![i]]));
    expect(row).toEqual({ f, name: "Claude guide", trig: 2, draft: 5, sent: 0, pub: 0, tap: 1, qr: 0, email: 1, push: 1, skip: 1, fail: 0 });
    expect(m.why).toEqual({ comment_too_old: 1 });
    expect(m.conv).toMatchObject({ email_per_tap: 1, push_per_email: 1 });
    expect(m.media).toEqual({ cols: ["media", "trig", "sent", "email"], rows: [["m1", 2, 0, 1]] });
    const all = h.svc.flows.metrics({}) as { rows: unknown[][] };
    expect(all.rows).toHaveLength(1);
  });

  it("flow_upsert rejects a follow-gated config", () => {
    const h = setup();
    const gated = leadFlow({ steps: [{ type: "private_reply", text: "Najpierw zaobserwuj", require_follow: true }] });
    expect(() => h.svc.flows.upsert(gated, "test", true)).toThrow(/follow-gating is not allowed/);
    expect(h.db.prepare("SELECT count(*) AS n FROM flows").get()).toEqual({ n: 0 });
  });

  it("unmatched DMs and comments stay in the inbox untouched", async () => {
    const h = setup();
    h.flow();
    h.flow({ name: "price", enabled: true, trigger: { type: "dm_keyword", keywords: ["cena"] }, steps: [{ type: "send_dm", text: "99 zł" }] });
    await h.svc.ingest([h.dm("Hej, kiedy następny live?"), h.comment("super odcinek")]);
    const items = h.db.prepare("SELECT read, labels FROM items").all() as { read: number; labels: string }[];
    expect(items.every((i) => i.read === 0 && !JSON.parse(i.labels).includes("auto"))).toBe(true);
    expect(h.drafts()).toHaveLength(0);
    expect(h.events()).toHaveLength(0);
    expect(h.runs()).toHaveLength(0);
  });
});

describe("send policy", () => {
  it("opt-out keywords stop all runs and block every later automation", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.ingest([h.dm("STOP")]);
    expect(h.runs()[0]!.state).toBe("stopped");
    expect(h.db.prepare("SELECT contact_id, keyword FROM contacts_optout").all()).toEqual([{ contact_id: "u9", keyword: "stop" }]);
    await h.svc.ingest([h.tap("GUIDE")]);
    await h.svc.ingest([h.comment("claude")]);
    expect(h.drafts().filter((d) => d.kind === "dm")).toHaveLength(0);
    expect(h.drafts().filter((d) => d.kind === "private_reply")).toHaveLength(1);
    expect(h.events("skipped").map((e) => e.reason)).toEqual(["opted_out", "opted_out"]);
    // the opt-out message itself stays visible to the human
    expect(JSON.parse(h.svc.store.item("i2")!.labels)).not.toContain("auto");
  });

  it("per-contact cooldown: one automated message per contact per flow step", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.ingest([h.comment("claude jeszcze raz")]);
    expect(h.drafts().filter((d) => d.kind === "private_reply")).toHaveLength(1);
    // the skipped private reply stops the run, so no second public reply either
    expect(h.events("skipped").map((e) => e.reason)).toEqual(["cooldown"]);
    expect(h.drafts()).toHaveLength(2);
    h.clock.t += 25 * H;
    await h.svc.ingest([h.comment("claude")]);
    expect(h.drafts().filter((d) => d.kind === "private_reply")).toHaveLength(2);
  });

  it("MAX_SENDS_PER_HOUR caps automated drafts", async () => {
    const h = setup({ MAX_SENDS_PER_HOUR: "3" });
    h.flow();
    await h.svc.ingest([h.comment("claude", { uid: "a" }), h.comment("claude", { uid: "b" })]);
    expect(h.drafts()).toHaveLength(3);
    expect(h.events("skipped").map((e) => e.reason)).toEqual(["limit"]);
  });

  it("one private reply per comment even if a human already drafted one", async () => {
    const h = setup({ AUTOMATIONS_ENABLED: "false" });
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    h.svc.draftReply({ to: "i1", text: "ręcznie", kind: "private_reply" }, "human");
    expect(h.drafts()).toHaveLength(1); // engine off: nothing evaluated

    const h2 = setup();
    h2.flow();
    const c = h2.comment("claude");
    h2.svc.store.ingest([c], h2.clock.t); // stored without evaluation, e.g. before the engine existed
    h2.svc.draftReply({ to: "i1", text: "ręcznie", kind: "private_reply" }, "human");
    await h2.svc.automations.evaluate(["i1"]);
    expect(h2.drafts().filter((d) => d.kind === "private_reply")).toHaveLength(1);
    expect(h2.events("skipped").map((e) => e.reason)).toEqual(["duplicate"]);
  });

  it("public replies rotate round-robin through the variants", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest(["a", "b", "c"].map((uid) => h.comment("claude", { uid })));
    expect(h.drafts().filter((d) => d.kind === "reply").map((d) => d.text)).toEqual(["Sprawdź DM 📩", "Wysłane!", "Sprawdź DM 📩"]);
  });

  it("AUTOMATIONS_ENABLED=false evaluates nothing", async () => {
    const h = setup({ AUTOMATIONS_ENABLED: "false" });
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    expect(h.drafts()).toHaveLength(0);
    expect(h.db.prepare("SELECT count(*) AS n FROM flow_seen").get()).toEqual({ n: 0 });
    expect(h.svc.overview().auto).toBe("off");
  });
});

describe("other triggers and steps", () => {
  it("dm_keyword + quick replies: a quick-reply tap continues the run", async () => {
    const h = setup();
    h.flow({
      name: "price",
      enabled: true,
      trigger: { type: "dm_keyword", keywords: ["cena"] },
      steps: [
        { type: "send_dm", text: "Który kurs?", quick_replies: [{ title: "Claude", payload: "Q_CLAUDE" }, { title: "CSS", payload: "Q_CSS" }] },
        { type: "send_dm", text: "Link: https://wozu.co/claude?utm_source=ig", buttons: [{ title: "Otwórz", url: "https://wozu.co/claude?utm_source=ig" }] },
      ],
    });
    await h.svc.ingest([h.dm("Jaka cena kursu?")]);
    expect(JSON.parse(h.drafts()[0]!.payload!).quick_replies).toHaveLength(2);
    await h.svc.ingest([h.dm("CSS", { raw: { message: { quick_reply: { payload: "Q_CSS" } } } })]);
    expect(h.drafts()).toHaveLength(2);
    expect(JSON.parse(h.drafts()[1]!.payload!).buttons).toEqual([{ title: "Otwórz", url: "https://wozu.co/claude?utm_source=ig" }]);
    expect(h.events("quick_reply")).toHaveLength(1);
    expect(h.runs()[0]!.state).toBe("done");
  });

  it("story replies, story mentions and ice-breaker postbacks start their own flows", async () => {
    const h = setup();
    const dmStep = (text: string) => [{ type: "send_dm", text }];
    h.flow({ name: "sr", enabled: true, trigger: { type: "story_reply", keywords: ["link"] }, steps: dmStep("Link do stories") });
    h.flow({ name: "sm", enabled: true, trigger: { type: "story_mention" }, steps: dmStep("Dzięki za oznaczenie!") });
    h.flow({ name: "ib", enabled: true, trigger: { type: "ice_breaker", payload: "ICE_PRICE" }, steps: dmStep("Cennik: …") });
    await h.svc.ingest([
      h.dm("poproszę link", { uid: "a", raw: { story: { reply_to: { id: "st1" } } } }),
      h.dm("😍", { uid: "x", raw: { story: { reply_to: { id: "st1" } } } }), // no keyword → untouched
      h.dm("[story reply/mention]", { uid: "b", raw: { story: { mention: { id: "st2" } } } }),
      h.dm("[tap] Ile kosztuje?", { uid: "c", raw: { postback: { payload: "ICE_PRICE", title: "Ile kosztuje?" } } }),
    ]);
    expect(h.drafts().map((d) => d.text)).toEqual(["Link do stories", "Dzięki za oznaczenie!", "Cennik: …"]);
    expect(h.db.prepare("SELECT media_id FROM flow_events WHERE type = 'triggered' ORDER BY id").all()).toEqual([
      { media_id: "st1" },
      { media_id: "st2" },
      { media_id: null },
    ]);
  });

  it("first matching flow wins by priority", async () => {
    const h = setup();
    h.flow({ name: "generic", enabled: true, priority: 200, trigger: { type: "dm_keyword", keywords: ["kurs"] }, steps: [{ type: "send_dm", text: "generic" }] });
    h.flow({ name: "specific", enabled: true, priority: 10, trigger: { type: "dm_keyword", keywords: ["kurs"] }, steps: [{ type: "send_dm", text: "specific" }] });
    await h.svc.ingest([h.dm("kurs")]);
    expect(h.drafts().map((d) => d.text)).toEqual(["specific"]);
  });

  it("soft_follow_ask never blocks; handoff labels the thread needs-wozu and ends the run", async () => {
    const h = setup();
    h.flow({
      name: "collab",
      enabled: true,
      trigger: { type: "dm_keyword", keywords: ["współpraca"] },
      steps: [{ type: "soft_follow_ask", text: "Zaobserwuj :)" }, { type: "send_dm", text: "Dzięki! Odezwę się." }, { type: "handoff", note: "collab lead" }],
    });
    await h.svc.ingest([h.dm("Hej, współpraca?")]);
    expect(h.drafts().map((d) => d.text)).toEqual(["Dzięki! Odezwę się."]);
    const item = h.svc.store.item("i1")!;
    expect(JSON.parse(item.labels)).toEqual(expect.arrayContaining(["needs-wozu", "auto"]));
    expect(item.read).toBe(0);
    expect(h.runs()[0]!.state).toBe("done");
  });

  it("editing a flow's steps stops its waiting runs", async () => {
    const h = setup();
    const f = h.flow();
    await h.svc.ingest([h.comment("claude")]);
    h.svc.flows.upsert({ ...leadFlow(), id: f, steps: leadFlow().steps.slice(0, 3) }, "test", true);
    expect(h.runs()[0]!.state).toBe("stopped");
    expect(h.events("skipped").map((e) => e.reason)).toEqual(["flow_changed"]);
    await h.svc.ingest([h.tap("GUIDE")]);
    expect(h.drafts().filter((d) => d.kind === "dm")).toHaveLength(0);
  });

  it("forgetting a person deletes their runs (and captured emails) but keeps the opt-out", async () => {
    const h = setup();
    h.flow();
    await h.svc.ingest([h.comment("claude")]);
    await h.svc.ingest([h.dm("stop")]);
    h.svc.store.forgetPerson("fake", "u9");
    expect(h.runs()).toHaveLength(0);
    expect(h.db.prepare("SELECT count(*) AS n FROM contacts_optout").get()).toEqual({ n: 1 });
  });

  it("inbox_overview reports auto counts for the last 24h", async () => {
    const h = setup({ AUTOMATIONS_AUTOSEND: "true" });
    h.flow(leadFlow({ mode: "auto" }));
    h.flow(leadFlow({ name: "d", trigger: { type: "comment_keyword", keywords: ["kurs"] } }));
    await h.svc.ingest([h.comment("claude", { uid: "a" }), h.comment("kurs", { uid: "b" })]);
    expect(h.svc.overview().auto).toEqual({ triggered: 2, sent: 2, pending: 2 });
  });
});
