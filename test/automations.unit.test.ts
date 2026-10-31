import { describe, expect, it } from "vitest";
import { extractEmail, isEmail, matchKeyword, normalize, optOutKeyword } from "../src/automations/match.js";
import { triggerSummary, validateFlow, type Trigger } from "../src/automations/schema.js";
import { classify, matchTrigger } from "../src/automations/triggers.js";

const comment = (text: string, extra: Record<string, unknown> = {}) => ({ src: "ig.cm" as const, text, raw: null, me: 0, ...extra });
const dm = (text: string, raw?: unknown) => ({ src: "ig.dm" as const, text, raw: raw === undefined ? null : JSON.stringify(raw), me: 0 });

describe("matcher", () => {
  it("normalises case, diacritics (incl. ł), punctuation and emoji", () => {
    expect(normalize("  CLAUDE!!! 🔥 ")).toBe("claude");
    expect(normalize("Zażółć gęślą jaźń")).toBe("zazolc gesla jazn");
    expect(normalize("Cłaudé,  kurs—AI?")).toBe("claude kurs ai");
    expect(normalize(null)).toBe("");
  });

  it("supports exact, word (default) and contains", () => {
    expect(matchKeyword("Claude!", ["claude"])).toBe("claude");
    expect(matchKeyword("chcę CLAUDE prosze", ["claude"])).toBe("claude");
    expect(matchKeyword("claudeai", ["claude"])).toBeUndefined();
    expect(matchKeyword("claudeai", ["claude"], "contains")).toBe("claude");
    expect(matchKeyword("claude please", ["claude"], "exact")).toBeUndefined();
    expect(matchKeyword("Claude.", ["claude"], "exact")).toBe("claude");
    expect(matchKeyword("daj mi przewodnik AI", ["przewodnik ai"])).toBe("przewodnik ai");
    expect(matchKeyword("", ["x"])).toBeUndefined();
  });

  it("opts out only on a whole-message keyword", () => {
    expect(optOutKeyword("STOP")).toBe("stop");
    expect(optOutKeyword("Stopp!")).toBe("stopp");
    expect(optOutKeyword("nie pisz.")).toBe("nie pisz");
    expect(optOutKeyword("Unsubscribe")).toBe("unsubscribe");
    expect(optOutKeyword("can't stop watching your reels")).toBeUndefined();
  });

  it("validates and extracts a single email address", () => {
    expect(isEmail("ania@example.pl")).toBe(true);
    expect(isEmail("a..b@example.pl")).toBe(false);
    expect(isEmail("ania@example")).toBe(false);
    expect(extractEmail("mój mail: Ania.K+ig@Example.COM.")).toBe("ania.k+ig@example.com");
    expect(extractEmail("<ania@example.pl>")).toBe("ania@example.pl");
    expect(extractEmail("ania at example dot pl")).toBeUndefined();
    expect(extractEmail("a@example.pl albo b@example.pl")).toBeUndefined();
  });
});

describe("triggers", () => {
  it("classifies comments, DMs, postbacks, quick replies and stories (webhook and poll shapes)", () => {
    expect(classify(comment("hi"), { id: "p1", native_id: "m1" })).toEqual({ kind: "comment", text: "hi", media: "m1", postId: "p1" });
    expect(classify(dm("hi"))?.kind).toBe("dm");
    expect(classify(dm("[tap] Wyślij", { postback: { payload: "GUIDE" } }))).toMatchObject({ kind: "postback", payload: "GUIDE", via: "button" });
    expect(classify(dm("Kurs", { message: { quick_reply: { payload: "KURS" } } }))).toMatchObject({ kind: "postback", payload: "KURS", via: "quick_reply" });
    expect(classify(dm("wow", { story: { reply_to: { id: "st1" } } }))).toMatchObject({ kind: "story_reply", story: "st1" });
    expect(classify(dm("", { story: { mention: { id: "st2" } } }))).toMatchObject({ kind: "story_mention", story: "st2" });
    expect(classify(dm("", { message: { attachments: [{ type: "story_mention" }] } }))?.kind).toBe("story_mention");
    expect(classify({ ...dm("me"), me: 1 })).toBeUndefined();
    expect(classify({ src: "ig.mn", text: "x", raw: null, me: 0 })).toBeUndefined();
  });

  it("matches each trigger type only on its kind", () => {
    const cm: Trigger = { type: "comment_keyword", keywords: ["claude"], media_ids: ["m1"] };
    expect(matchTrigger(cm, { kind: "comment", text: "Claude!", media: "m1" })).toEqual({ kw: "claude" });
    expect(matchTrigger(cm, { kind: "comment", text: "Claude!", media: "m2" })).toBeUndefined();
    expect(matchTrigger(cm, { kind: "comment", text: "Claude!", media: "x", postId: "m1" })).toEqual({ kw: "claude" });
    expect(matchTrigger(cm, { kind: "dm", text: "claude" })).toBeUndefined();
    expect(matchTrigger({ type: "dm_keyword", keywords: ["cena"] }, { kind: "dm", text: "Jaka cena?" })).toEqual({ kw: "cena" });
    expect(matchTrigger({ type: "dm_keyword", keywords: ["cena"] }, { kind: "story_reply", text: "cena" })).toBeUndefined();
    expect(matchTrigger({ type: "story_reply" }, { kind: "story_reply", text: "😍" })).toEqual({});
    expect(matchTrigger({ type: "story_reply", keywords: ["link"] }, { kind: "story_reply", text: "😍" })).toBeUndefined();
    expect(matchTrigger({ type: "story_mention" }, { kind: "story_mention", text: "" })).toEqual({});
    expect(matchTrigger({ type: "ice_breaker", payload: ["PRICE", "FAQ"] }, { kind: "postback", text: "", payload: "FAQ", via: "button" })).toEqual({ kw: "FAQ" });
    expect(matchTrigger({ type: "postback", payload: "GUIDE" }, { kind: "postback", text: "", payload: "OTHER", via: "button" })).toBeUndefined();
  });

  it("summarises triggers compactly", () => {
    expect(triggerSummary({ type: "comment_keyword", keywords: ["claude", "ai"], media_ids: ["p3"] })).toBe("cm:claude,ai@p3");
    expect(triggerSummary({ type: "postback", payload: "GUIDE" })).toBe("pb:GUIDE");
  });
});

const ok = {
  name: "Claude guide",
  trigger: { type: "comment_keyword", keywords: ["claude"] },
  steps: [
    { type: "private_reply", text: "Kliknij", button: { title: "Wyślij", payload: "GUIDE" } },
    { type: "public_reply", variants: ["Sprawdź DM"] },
    { type: "ask_email", text: "Email?" },
    { type: "push_email", provider: "plunk" },
  ],
};

describe("flow validation (send policy in code)", () => {
  it("accepts a valid flow", () => {
    expect(validateFlow(ok).steps).toHaveLength(4);
  });

  it("rejects follow-gating in any shape", () => {
    const gated = [
      { ...ok, steps: [{ ...ok.steps[0], require_follow: true }, ...ok.steps.slice(1)] },
      { ...ok, only_followers: true },
      { ...ok, steps: [...ok.steps, { type: "follow_gate" }] },
      { ...ok, steps: [{ type: "send_dm", text: "x", if_following: { else: "stop" } }] },
    ];
    for (const g of gated) expect(() => validateFlow(g)).toThrow(/follow-gating is not allowed/);
    expect(() => validateFlow({ ...ok, trigger: { type: "new_follower" } })).toThrow(/no follow trigger exists/);
    // the soft, non-blocking ask is fine
    expect(() => validateFlow({ name: "x", trigger: { type: "dm_keyword", keywords: ["a"] }, steps: [{ type: "soft_follow_ask", text: "Zaobserwuj :)" }] })).not.toThrow();
  });

  it("enforces Meta limits and step ordering", () => {
    const bad = (patch: Record<string, unknown>) => () => validateFlow({ ...ok, ...patch });
    expect(bad({ steps: [{ type: "private_reply", text: "x".repeat(641) }] })).toThrow(/640/);
    expect(bad({ steps: [{ type: "public_reply", variants: ["a", "b", "c", "d", "e", "f"] }] })).toThrow(/variants/);
    expect(bad({ steps: [{ type: "private_reply", text: "x", button: { title: "x".repeat(21), payload: "P" } }] })).toThrow(/title/);
    expect(bad({ steps: [{ type: "private_reply", text: "a" }, { type: "private_reply", text: "b" }] })).toThrow(/only one private reply/);
    expect(bad({ steps: [{ type: "private_reply", text: "a", button: { title: "Link", url: "https://wozu.co" } }, { type: "send_dm", text: "b" }] })).toThrow(
      /needs a postback button/,
    );
    expect(bad({ trigger: { type: "dm_keyword", keywords: ["a"] }, steps: [{ type: "private_reply", text: "a" }] })).toThrow(/comment_keyword/);
    expect(bad({ trigger: { type: "dm_keyword", keywords: ["a"] }, steps: [{ type: "push_email", provider: "plunk" }] })).toThrow(/earlier ask_email/);
    expect(bad({ trigger: { type: "dm_keyword", keywords: ["a"] }, steps: [{ type: "handoff" }, { type: "tag", label: "x" }] })).toThrow(/last step/);
    const qr = Array.from({ length: 14 }, (_, i) => ({ title: `q${i}`, payload: `Q${i}` }));
    expect(bad({ trigger: { type: "dm_keyword", keywords: ["a"] }, steps: [{ type: "send_dm", text: "a", quick_replies: qr }] })).toThrow(/quick_replies/);
    expect(
      bad({ trigger: { type: "dm_keyword", keywords: ["a"] }, steps: [{ type: "send_dm", text: "a", buttons: [{ title: "a", payload: "A" }], quick_replies: [{ title: "b", payload: "B" }] }] }),
    ).toThrow(/not both/);
    expect(bad({ steps: [{ type: "launch_rocket" }] })).toThrow(/steps.0.type must be one of/);
    expect(bad({ extra: 1 })).toThrow();
    expect(bad({ steps: [{ type: "private_reply", text: "a", button: { title: "x", url: "javascript:alert(1)" } }] })).toThrow();
  });
});
