import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compact.js";
import { decrypt, encrypt, parseKey } from "../src/core/crypto.js";
import { TransientError } from "../src/core/errors.js";
import { decodeCursor, encodeCursor } from "../src/core/ids.js";
import { triage } from "../src/core/triage.js";
import { Service } from "../src/core/service.js";
import { createLogger } from "../src/log.js";
import { ENC_KEY, fakeSetup } from "./helpers.js";

describe("ids and cursors", () => {
  it("issues short prefixed base36 ids", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(40);
    await svc.sync();
    const ids = (svc.db.prepare("SELECT id FROM items ORDER BY seq").all() as { id: string }[]).map((r) => r.id);
    expect(ids[0]).toBe("i1");
    expect(ids[35]).toBe("i10");
    expect(ids.every((id) => id.length <= 4)).toBe(true);
  });

  it("round-trips cursors and rejects garbage", () => {
    expect(decodeCursor(encodeCursor(12345))).toBe(12345);
    expect(() => decodeCursor("nope")).toThrow(/bad cursor/);
  });
});

describe("M0 acceptance", () => {
  it("inbox_overview + inbox_list for 20 fake items stay under 1,500 tokens", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(20);
    await svc.sync();
    const ov = svc.overview();
    const list = svc.list({});
    expect((list as { rows: unknown[] }).rows).toHaveLength(20);
    const tokens = estimateTokens(ov) + estimateTokens(list);
    expect(tokens).toBeLessThan(1500);
    // the terser TSV format is smaller still
    expect(estimateTokens(svc.list({ fmt: "lines" }))).toBeLessThan(estimateTokens(list));
  });

  it("`since` returns only new items", async () => {
    const { svc, fake, clock } = fakeSetup();
    fake.generate(5);
    await svc.sync();
    const first = svc.list({}) as { rows: unknown[][]; next: string; more: boolean };
    expect(first.rows).toHaveLength(5);
    expect(first.more).toBe(false);

    expect((svc.list({ since: first.next }) as { rows: unknown[] }).rows).toHaveLength(0);

    clock.t += 60_000;
    fake.generate(3, 30_000);
    await svc.sync({ force: true });
    const second = svc.list({ since: first.next }) as { rows: unknown[][]; cols: string[] };
    expect(second.rows).toHaveLength(3);
    const idCol = second.cols.indexOf("id");
    expect(second.rows.map((r) => r[idCol])).toEqual(["i6", "i7", "i8"]);
  });

  it("paginates with `more` and a continuation cursor", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(30);
    await svc.sync();
    const p1 = svc.list({ limit: 20 }) as { rows: unknown[]; next: string; more: boolean; unread_left: number };
    expect(p1.more).toBe(true);
    expect(p1.unread_left).toBe(10);
    const p2 = svc.list({ limit: 20, since: p1.next }) as { rows: unknown[]; more: boolean };
    expect(p2.rows).toHaveLength(10);
    expect(p2.more).toBe(false);
  });

  it("send_approved on an unapproved draft fails", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(2);
    await svc.sync();
    const d = svc.draftReply({ to: "i1", text: "Hej! Minikurs kosztuje 99 zł." }, "test");
    await expect(svc.sendApproved(d.d!, "agent")).rejects.toThrow(/not approved/);
    expect(fake.sent).toHaveLength(0);
  });

  it("double send_approved sends once (sequential and concurrent)", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(4);
    await svc.sync();
    const a = svc.draftReply({ to: "i1", text: "Odpowiedź A" }, "t").d!;
    const b = svc.draftReply({ to: "i3", text: "Odpowiedź B" }, "t").d!;
    svc.approve(a, "human");
    svc.approve(b, "human");

    const r1 = await svc.sendApproved(a, "agent");
    const r2 = await svc.sendApproved(a, "agent");
    expect(r1.st).toBe("sent");
    expect(r2).toMatchObject({ st: "sent", nid: r1.nid, dup: true });

    const [c1, c2] = await Promise.all([svc.sendApproved(b, "agent"), svc.sendApproved(b, "agent")]);
    expect([c1.st, c2.st].sort()).toEqual(["sending", "sent"]);
    expect(fake.sent).toHaveLength(2);
    const audit = svc.db.prepare("SELECT count(*) AS n FROM audit WHERE action = 'sent'").get() as { n: number };
    expect(audit.n).toBe(2);
  });

  it("kill switch: SENDING_ENABLED=false keeps approved drafts unsent", async () => {
    const { svc, fake } = fakeSetup({ SENDING_ENABLED: "false" });
    fake.generate(1);
    await svc.sync();
    const d = svc.draftReply({ to: "i1", text: "hej" }, "t").d!;
    svc.approve(d, "human");
    await expect(svc.sendApproved(d, "agent")).rejects.toThrow(/SENDING_ENABLED=false/);
    expect(fake.sent).toHaveLength(0);
    expect(svc.overview().send).toBe("off");
  });
});

describe("drafts", () => {
  it("idempotency key returns the same draft", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(1);
    await svc.sync();
    const a = svc.draftReply({ to: "i1", text: "x", key: "k1" }, "t");
    const b = svc.draftReply({ to: "i1", text: "x", key: "k1" }, "t");
    expect(b).toMatchObject({ d: a.d, dup: true });
  });

  it("refuses DM drafts outside the 24h window with a clear reason", async () => {
    const { svc, fake, clock } = fakeSetup();
    fake.generate(1); // i1 is a DM
    await svc.sync();
    clock.t += 25 * 3600_000;
    expect(() => svc.draftReply({ to: "i1", text: "late" }, "t")).toThrow(/reply window closed: last message from @ania_k was 27h ago \(limit 24h\)/);
  });

  it("re-checks the DM window at approval and send time", async () => {
    const { svc, fake, clock } = fakeSetup();
    fake.generate(1);
    await svc.sync();
    const d = svc.draftReply({ to: "i1", text: "ok" }, "t").d!;
    clock.t += 25 * 3600_000;
    expect(() => svc.approve(d, "human")).toThrow(/window closed/);
  });

  it("enforces one private reply per comment and DM length", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(2); // i2 is a comment
    await svc.sync();
    svc.draftReply({ to: "i2", text: "priv", kind: "private_reply" }, "t");
    expect(() => svc.draftReply({ to: "i2", text: "again", kind: "private_reply" }, "t")).toThrow(/only one private reply/);
    expect(() => svc.draftReply({ to: "i1", text: "x".repeat(1001) }, "t")).toThrow(/too long: 1001\/1000/);
  });

  it("retries transient send failures, then succeeds", async () => {
    const { svc, fake, clock } = fakeSetup();
    fake.generate(2);
    await svc.sync();
    const d = svc.draftModeration({ id: "i2", action: "hide" }, "t").d!;
    svc.approve(d, "human");
    fake.failNext.push(new TransientError("graph 500"));
    const r = await svc.sendApproved(d, "agent");
    expect(r).toMatchObject({ st: "approved", retry: true });
    clock.t += 31_000;
    expect(await svc.retryDue()).toBe(1);
    expect(svc.draftGet(d).st).toBe("sent");
    expect(svc.itemGet({ id: "i2" }).x).toMatch(/\[hidden\]$/);
  });

  it("marks drafts interrupted mid-send as failed on restart (never auto-resends)", async () => {
    const { svc, fake, db, config } = fakeSetup();
    fake.generate(1);
    await svc.sync();
    const d = svc.draftReply({ to: "i1", text: "x" }, "t").d!;
    db.prepare("UPDATE drafts SET status = 'sending' WHERE id = ?").run(d);
    const svc2 = new Service({ db, config, log: createLogger("silent"), connectors: [fake] });
    expect(svc2.draftGet(d)).toMatchObject({ st: "failed" });
  });

  it("only allows agent approval when APPROVAL=agent-confirmed", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(1);
    await svc.sync();
    const d = svc.draftReply({ to: "i1", text: "x" }, "t").d!;
    expect(() => svc.approve(d, "mcp:agent", { by: "wozu", ref: "chat:1" })).toThrow(/APPROVAL=human/);
  });
});

describe("reading", () => {
  it("thread_get returns cached note and flags new messages since it", async () => {
    const { svc, fake, clock } = fakeSetup();
    fake.generate(1);
    await svc.sync();
    const t = svc.itemGet({ id: "i1" }).t as string;
    svc.threadNote({ t, summary: "Asks price of minikurs; beginner" }, "agent");
    expect(svc.threadGet({ t })).toMatchObject({ sum: "Asks price of minikurs; beginner", win: expect.stringMatching(/h$/) });
    clock.t += 60_000;
    fake.push({ net: "fake", nativeId: "x1", src: "ig.dm", threadNativeId: "dm:u0", authorId: "u0", who: "@ania_k", text: "halo?", ts: clock.t });
    await svc.sync({ force: true });
    expect(svc.threadGet({ t })).toMatchObject({ new_since_sum: 1 });
  });

  it("marks read up to a cursor and filters by label", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(10);
    await svc.sync();
    const spam = svc.list({ lbl: "spam" }) as { rows: unknown[] };
    expect(spam.rows.length).toBeGreaterThan(0);
    const { cursor } = svc.overview() as { cursor: string };
    svc.mark({ upTo: cursor }, "t");
    expect(svc.overview().unread).toEqual({});
  });

  it("searches with FTS and tolerates FTS syntax in queries", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(10);
    await svc.sync();
    const r = svc.search({ q: "minikurs" }) as { rows: unknown[] };
    expect(r.rows).toHaveLength(1);
    expect(() => svc.search({ q: 'AND OR "(' })).not.toThrow();
  });

  it("enforces caps on limit and maxChars", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(60);
    await svc.sync();
    const r = svc.list({ limit: 500, maxChars: 10 }) as { rows: unknown[][]; cols: string[] };
    expect(r.rows).toHaveLength(50);
    const x = r.cols.indexOf("x");
    expect((r.rows[0]![x] as string).length).toBeLessThanOrEqual(20);
  });

  it("ignores unknown fields instead of echoing them", async () => {
    const { svc, fake } = fakeSetup();
    fake.generate(1);
    await svc.sync();
    const r = svc.list({ fields: ["who", "bogus", "ts"] }) as { cols: string[] };
    expect(r.cols).toEqual(["id", "who", "ts"]);
  });
});

describe("primitives", () => {
  it("triage labels questions, leads, spam and complaints (EN + PL)", () => {
    expect(triage("Ile kosztuje minikurs?")).toEqual(["q", "lead", "needs-wozu"]);
    expect(triage("Świetny odcinek 🔥")).toEqual(["praise"]);
    expect(triage("check my profile for crypto")).toEqual(["spam"]);
    expect(triage("link nie działa")).toEqual(["complaint", "needs-wozu"]);
    expect(triage("Ile kosztuje?", true)).toEqual([]);
  });

  it("encrypts tokens with AES-256-GCM and detects tampering", () => {
    const k = parseKey(ENC_KEY);
    const enc = encrypt("EAAsecret", k);
    expect(enc).not.toContain("EAAsecret");
    expect(decrypt(enc, k)).toBe("EAAsecret");
    const bad = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decrypt(bad, k)).toThrow();
  });

  it("keeps the audit log append-only", async () => {
    const { svc } = fakeSetup();
    svc.store.audit("t", "x");
    expect(() => svc.db.prepare("DELETE FROM audit").run()).toThrow(/append-only/);
    expect(() => svc.db.prepare("UPDATE audit SET actor = 'y'").run()).toThrow(/append-only/);
  });

  it("forgets a person and purges old text per retention", async () => {
    const { svc, fake, clock } = fakeSetup();
    fake.generate(16);
    await svc.sync();
    const before = svc.store.exportPerson("fake", "u0").length;
    expect(before).toBeGreaterThan(0);
    expect(svc.store.forgetPerson("fake", "u0")).toBe(before);
    expect(svc.store.exportPerson("fake", "u0")).toHaveLength(0);
    clock.t += 400 * 864e5;
    expect(svc.purge().text).toBeGreaterThan(0);
  });
});
