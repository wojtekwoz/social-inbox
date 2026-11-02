import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { DraftRow, IncomingItem } from "../src/core/types.js";
import { fakeSetup } from "./helpers.js";

// Fake items: i1 DM @ania_k (u0), i2 comment @marek.p (u1), i3 DM @kasia_codes (u2), i5 comment @julia.design (u4).

async function setup(env: Record<string, string>) {
  const s = fakeSetup(env);
  s.fake.generate(5);
  await s.svc.sync();
  const approved = (to: string) => {
    const d = s.svc.draftReply({ to, text: "Hej, test!" }, "agent").d;
    s.svc.approve(d, "human");
    return d;
  };
  const hide = (id: string) => {
    const d = s.svc.draftModeration({ id, action: "hide" }, "agent").d as string;
    s.svc.approve(d, "human");
    return d;
  };
  const draft = (d: string) => s.db.prepare("SELECT * FROM drafts WHERE id = ?").get(d) as DraftRow;
  const audits = (action: string) => (s.db.prepare("SELECT count(*) AS n FROM audit WHERE action = ?").get(action) as { n: number }).n;
  return { ...s, approved, hide, draft, audits };
}

describe("SEND_MODE config", () => {
  it("defaults to off with an empty allowlist; parses ids and usernames case-insensitively", () => {
    const def = loadConfig({});
    expect(def.sendMode).toBe("off");
    expect(def.sendAllowlist).toEqual([]);
    const cfg = loadConfig({ SEND_MODE: "Testers", SEND_ALLOWLIST: " 6000000000000001, @Tester_One ,tester_two,, @tester_one" });
    expect(cfg.sendMode).toBe("testers");
    expect(cfg.sendAllowlist).toEqual(["6000000000000001", "tester_one", "tester_two"]);
    expect(() => loadConfig({ SEND_MODE: "everyone" })).toThrow(/SEND_MODE must be one of off, testers, all/);
  });
});

describe("tester-only send path", () => {
  it("off by default: nothing reaches connector.send even with SENDING_ENABLED=true", async () => {
    const h = await setup({ SENDING_ENABLED: "true", SEND_MODE: "" });
    expect(h.config.sendMode).toBe("off");
    const d = h.approved("i1");
    await expect(h.svc.sendApproved(d, "agent")).rejects.toThrow("sending is disabled (SEND_MODE=off); draft stays approved");
    await h.svc.retryDue();
    expect(h.fake.sent).toHaveLength(0);
    expect(h.draft(d).status).toBe("approved");
    expect(h.svc.overview().send).toBe("off");
  });

  it("SEND_MODE=testers blocks non-allowlisted recipients (DM, comment reply, moderation) without retry", async () => {
    const h = await setup({ SENDING_ENABLED: "true", SEND_MODE: "testers", SEND_ALLOWLIST: "@tester_one,6000000000000001" });
    expect(h.svc.overview().send).toBe("testers(2)");
    const dm = h.approved("i1");
    const r = await h.svc.sendApproved(dm, "agent");
    expect(r).toMatchObject({ st: "failed", blocked: true, err: "recipient @ania_k is not on SEND_ALLOWLIST (SEND_MODE=testers)" });
    expect(await h.svc.sendApproved(h.approved("i2"), "agent")).toMatchObject({ st: "failed", err: expect.stringMatching(/@marek\.p is not on SEND_ALLOWLIST/) });
    expect(await h.svc.sendApproved(h.hide("i5"), "agent")).toMatchObject({ st: "failed", err: expect.stringMatching(/@julia\.design is not on SEND_ALLOWLIST/) });

    await h.svc.retryDue();
    expect(h.fake.sent).toHaveLength(0);
    expect(h.draft(dm)).toMatchObject({ status: "failed", attempts: 0, next_at: null });
    expect(h.audits("send_blocked")).toBe(3);
    expect(h.audits("sent")).toBe(0);
    // A re-call does not resend either.
    await expect(h.svc.sendApproved(dm, "agent")).rejects.toThrow(/is failed/);
  });

  it("allowlisted testers pass by IGSID and by @username (case-insensitive, @ optional)", async () => {
    const h = await setup({ SENDING_ENABLED: "true", SEND_MODE: "testers", SEND_ALLOWLIST: "U0, @Marek.P ,julia.design" });
    expect(await h.svc.sendApproved(h.approved("i1"), "agent")).toMatchObject({ st: "sent" }); // DM, by IGSID
    expect(await h.svc.sendApproved(h.approved("i2"), "agent")).toMatchObject({ st: "sent" }); // comment reply, by @username
    expect(await h.svc.sendApproved(h.hide("i5"), "agent")).toMatchObject({ st: "sent" }); // moderation, by username
    expect(await h.svc.sendApproved(h.approved("i3"), "agent")).toMatchObject({ st: "failed", blocked: true });
    expect(h.fake.sent.map((s) => [s.draft.kind, s.recipientId ?? s.item?.who])).toEqual([
      ["dm", "u0"],
      ["reply", "@marek.p"],
      ["hide", "@julia.design"],
    ]);
  });

  it("SEND_MODE=all sends to anyone, but still needs SENDING_ENABLED=true", async () => {
    const h = await setup({ SENDING_ENABLED: "true", SEND_MODE: "all" });
    expect(h.svc.overview().send).toBe("all");
    expect(await h.svc.sendApproved(h.approved("i1"), "agent")).toMatchObject({ st: "sent" });
    expect(h.fake.sent).toHaveLength(1);

    const off = await setup({ SENDING_ENABLED: "false", SEND_MODE: "all" });
    await expect(off.svc.sendApproved(off.approved("i1"), "agent")).rejects.toThrow(/SENDING_ENABLED=false/);
    expect(off.fake.sent).toHaveLength(0);
    expect(off.svc.overview().send).toBe("off");
  });

  it("automation drafts go through the same gate", async () => {
    const h = await setup({
      SENDING_ENABLED: "true",
      SEND_MODE: "testers",
      SEND_ALLOWLIST: "@tester_one",
      AUTOMATIONS_ENABLED: "true",
      AUTOMATIONS_AUTOSEND: "true",
    });
    h.svc.flows.upsert(
      { name: "guide", enabled: true, mode: "auto", trigger: { type: "comment_keyword", keywords: ["claude"] }, steps: [{ type: "private_reply", text: "Hej!" }] },
      "test",
      true,
    );
    const comment = (nid: string, uid: string, who: string): IncomingItem => ({
      net: "fake", nativeId: nid, src: "ig.cm", threadNativeId: nid, authorId: uid, who, text: "Claude!", ts: h.clock.t - 60_000, post: { nativeId: "m1" },
    });
    await h.svc.ingest([comment("c1", "u8", "@tester_one"), comment("c2", "u9", "@fan")]);
    expect(h.fake.sent.map((s) => s.item?.who)).toEqual(["@tester_one"]);
    const auto = (h.db.prepare("SELECT status, error FROM drafts WHERE flow_run_id IS NOT NULL ORDER BY rowid").all() as DraftRow[]).map((d) => [d.status, d.error]);
    expect(auto).toEqual([
      ["sent", null],
      ["failed", "recipient @fan is not on SEND_ALLOWLIST (SEND_MODE=testers)"],
    ]);
  });
});
