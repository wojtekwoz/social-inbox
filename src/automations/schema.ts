import { z } from "zod";
import { UserError } from "../core/errors.js";

// Flow documents: small JSON that agents read and edit. Validation enforces the
// Meta send policy in code (SPEC-automations §5), not by convention.

const keywords = z.array(z.string().trim().min(1).max(50)).min(1).max(20);
const match = z.enum(["exact", "word", "contains"]).optional();
const payload = z.string().trim().min(1).max(1000);
const title = z.string().trim().min(1).max(20);
const text = (max: number) => z.string().trim().min(1).max(max);

const payloads = z.union([payload, z.array(payload).min(1).max(20)]);

export const triggerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("comment_keyword"),
    keywords,
    match,
    media_ids: z.union([z.literal("any"), z.array(z.string().min(1)).min(1).max(50)]).optional(),
  }),
  z.strictObject({ type: z.literal("dm_keyword"), keywords, match }),
  z.strictObject({ type: z.literal("story_reply"), keywords: keywords.optional(), match }),
  z.strictObject({ type: z.literal("story_mention") }),
  z.strictObject({ type: z.literal("postback"), payload: payloads }),
  z.strictObject({ type: z.literal("ice_breaker"), payload: payloads }),
]);

const postbackButton = z.strictObject({ title, payload });
const urlButton = z.strictObject({ title, url: z.url({ protocol: /^https?$/ }).max(2000) });
const button = z.union([postbackButton, urlButton]);
const quickReply = z.strictObject({ title, payload });

export const stepSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("private_reply"), text: text(640), button: button.optional() }),
  z.strictObject({ type: z.literal("public_reply"), variants: z.array(text(2200)).min(1).max(5) }),
  z.strictObject({
    type: z.literal("send_dm"),
    text: text(1000),
    buttons: z.array(button).min(1).max(3).optional(),
    quick_replies: z.array(quickReply).min(1).max(13).optional(),
  }),
  z.strictObject({ type: z.literal("ask_email"), text: text(1000), retry_text: text(1000).optional() }),
  z.strictObject({
    type: z.literal("push_email"),
    provider: z.enum(["plunk", "mailerlite"]),
    tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
    group: z.string().trim().min(1).max(100).optional(),
    event: z.string().trim().min(1).max(100).optional(),
  }),
  z.strictObject({ type: z.literal("tag"), label: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,29}$/, "lowercase a-z 0-9 _ -, max 30") }),
  z.strictObject({ type: z.literal("soft_follow_ask"), text: text(1000) }),
  z.strictObject({ type: z.literal("handoff"), note: z.string().trim().max(300).optional() }),
]);

export const flowSchema = z.strictObject({
  id: z.string().regex(/^f[0-9a-z]+$/).optional(),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  mode: z.enum(["draft", "auto"]).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(12),
});

export type Trigger = z.infer<typeof triggerSchema>;
export type Step = z.infer<typeof stepSchema>;
export type FlowInput = z.infer<typeof flowSchema>;
export type Button = z.infer<typeof button>;

export const TRIGGER_TYPES = triggerSchema.options.map((o) => o.shape.type.value);
export const STEP_TYPES = stepSchema.options.map((o) => o.shape.type.value);

/** Steps that send a DM and therefore need an open 24 h window. */
export const WINDOW_STEPS = new Set<Step["type"]>(["send_dm", "ask_email", "soft_follow_ask"]);

export const isPostback = (b: Button): b is { title: string; payload: string } => "payload" in b;

/** Postback payloads a step arms (buttons or quick replies that a later tap answers). */
export function armedPayloads(s: Step): string[] {
  if (s.type === "private_reply") return s.button && isPostback(s.button) ? [s.button.payload] : [];
  if (s.type === "send_dm") return [...(s.buttons ?? []).filter(isPostback).map((b) => b.payload), ...(s.quick_replies ?? []).map((q) => q.payload)];
  return [];
}

const FOLLOW_GATING =
  "follow-gating is not allowed: delivery may never depend on following the account (Meta policy). " +
  "Use a soft_follow_ask step for an optional, non-blocking ask.";

/** Any key mentioning "follow" (require_follow, if_following, followers_only, …) is a gate. */
function findFollowGate(v: unknown, path: string[] = []): string | undefined {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      const hit = findFollowGate(x, [...path, String(i)]);
      if (hit) return hit;
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (/follow/i.test(k)) return [...path, k].join(".");
      if (k === "type" && typeof x === "string" && /follow/i.test(x) && x !== "soft_follow_ask") return [...path, k].join(".");
      const hit = findFollowGate(x, [...path, k]);
      if (hit) return hit;
    }
  }
  return undefined;
}

function issues(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "flow"}: ${i.message}`)
    .join("; ");
}

/** Parses a flow document and enforces the send policy. Throws a UserError (422) with every reason. */
export function validateFlow(input: unknown): FlowInput {
  const o = (input ?? {}) as { trigger?: { type?: unknown }; steps?: unknown };
  const tt = o.trigger?.type;
  if (typeof tt === "string" && /follow/i.test(tt))
    throw new UserError("no follow trigger exists: flows only start when someone acts first (comment, DM, story reply/mention, button)", 422);
  const gate = findFollowGate(input);
  if (gate) throw new UserError(`${gate}: ${FOLLOW_GATING}`, 422);
  if (typeof tt === "string" && !TRIGGER_TYPES.includes(tt as never))
    throw new UserError(`trigger.type must be one of ${TRIGGER_TYPES.join(", ")}`, 422);
  if (Array.isArray(o.steps))
    for (const [i, s] of o.steps.entries()) {
      const st = (s as { type?: unknown } | null)?.type;
      if (!STEP_TYPES.includes(st as never)) throw new UserError(`steps.${i}.type must be one of ${STEP_TYPES.join(", ")}`, 422);
    }

  const r = flowSchema.safeParse(input);
  if (!r.success) throw new UserError(issues(r.error), 422);
  const f = r.data;
  const errs: string[] = [];
  const comment = f.trigger.type === "comment_keyword";
  let armed = false;
  let asked = false;
  f.steps.forEach((s, i) => {
    const at = `steps.${i}`;
    if ((s.type === "private_reply" || s.type === "public_reply") && !comment) errs.push(`${at}: ${s.type} only works with a comment_keyword trigger`);
    if (s.type === "private_reply" && f.steps.findIndex((x) => x.type === "private_reply") !== i) errs.push(`${at}: only one private reply per comment`);
    if (s.type === "send_dm") {
      if (s.buttons && s.quick_replies) errs.push(`${at}: use buttons or quick_replies, not both`);
      if (s.buttons && [...s.text].length > 640) errs.push(`${at}: text with buttons is limited to 640 chars`);
    }
    if (WINDOW_STEPS.has(s.type) && comment && !armed)
      errs.push(`${at}: ${s.type} in a comment flow needs a postback button on an earlier private_reply (the commenter must tap first to open the 24h window)`);
    if (s.type === "push_email" && !asked) errs.push(`${at}: push_email needs an earlier ask_email`);
    if (s.type === "handoff" && i !== f.steps.length - 1) errs.push(`${at}: handoff ends the run and must be the last step`);
    if (armedPayloads(s).length) armed = true;
    if (s.type === "ask_email") asked = true;
  });
  if (errs.length) throw new UserError(errs.join("; "), 422);
  return f;
}

export function triggerSummary(t: Trigger): string {
  switch (t.type) {
    case "comment_keyword": {
      const on = !t.media_ids || t.media_ids === "any" ? "" : `@${t.media_ids.length === 1 ? t.media_ids[0] : `${t.media_ids.length} posts`}`;
      return `cm:${t.keywords.join(",")}${on}`;
    }
    case "dm_keyword":
      return `dm:${t.keywords.join(",")}`;
    case "story_reply":
      return t.keywords ? `story_reply:${t.keywords.join(",")}` : "story_reply";
    case "story_mention":
      return "story_mention";
    case "postback":
    case "ice_breaker":
      return `${t.type === "postback" ? "pb" : "ib"}:${[t.payload].flat().join(",")}`;
  }
}
