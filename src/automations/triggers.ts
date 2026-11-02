import type { ItemRow } from "../core/types.js";
import { matchKeyword } from "./match.js";
import type { Trigger } from "./schema.js";

// What an inbound item is, from the engine's point of view. Works on raw payloads from
// both webhooks (normalised in connectors/meta/webhook.ts) and the Graph poller.

export type Inbound =
  | { kind: "comment"; text: string; media?: string; postId?: string }
  | { kind: "dm"; text: string }
  | { kind: "story_reply"; text: string; story?: string }
  | { kind: "story_mention"; text: string; story?: string }
  | { kind: "postback"; text: string; payload: string; via: "button" | "quick_reply" };

interface RawDm {
  postback?: { payload?: string; title?: string };
  quick_reply?: { payload?: string };
  message?: { quick_reply?: { payload?: string }; reply_to?: { story?: { id?: string } }; attachments?: { type?: string }[] };
  story?: { reply_to?: { id?: string }; mention?: { id?: string } };
}

const parse = (raw: string | null): RawDm => {
  if (!raw) return {};
  try {
    return (JSON.parse(raw) ?? {}) as RawDm;
  } catch {
    return {};
  }
};

/** Classifies an inbound item. Outbound (me) items and unsupported sources return undefined. */
export function classify(item: Pick<ItemRow, "src" | "text" | "raw" | "me">, post?: { id: string; native_id: string }): Inbound | undefined {
  if (item.me) return undefined;
  const text = item.text ?? "";
  if (item.src === "ig.cm") return { kind: "comment", text, media: post?.native_id, postId: post?.id };
  if (item.src !== "ig.dm") return undefined;
  const r = parse(item.raw);
  if (r.postback?.payload) return { kind: "postback", text, payload: r.postback.payload, via: "button" };
  const qr = r.message?.quick_reply?.payload ?? r.quick_reply?.payload;
  if (qr) return { kind: "postback", text, payload: qr, via: "quick_reply" };
  if (r.story?.mention || r.message?.attachments?.some((a) => a.type === "story_mention"))
    return { kind: "story_mention", text, story: r.story?.mention?.id };
  if (r.story?.reply_to || r.message?.reply_to?.story)
    return { kind: "story_reply", text, story: r.story?.reply_to?.id ?? r.message?.reply_to?.story?.id };
  return { kind: "dm", text };
}

export interface TriggerMatch {
  kw?: string;
}

/** Does `t` fire for this inbound item? `checkMedia=false` is used by dry runs without a post. */
export function matchTrigger(t: Trigger, i: Inbound, checkMedia = true): TriggerMatch | undefined {
  switch (t.type) {
    case "comment_keyword": {
      if (i.kind !== "comment") return undefined;
      if (checkMedia && t.media_ids && t.media_ids !== "any") {
        const ids = t.media_ids;
        if (!ids.some((m) => m === i.media || m === i.postId)) return undefined;
      }
      const kw = matchKeyword(i.text, t.keywords, t.match);
      return kw ? { kw } : undefined;
    }
    case "dm_keyword": {
      if (i.kind !== "dm") return undefined;
      const kw = matchKeyword(i.text, t.keywords, t.match);
      return kw ? { kw } : undefined;
    }
    case "story_reply": {
      if (i.kind !== "story_reply") return undefined;
      if (!t.keywords) return {};
      const kw = matchKeyword(i.text, t.keywords, t.match);
      return kw ? { kw } : undefined;
    }
    case "story_mention":
      return i.kind === "story_mention" ? {} : undefined;
    case "postback":
    case "ice_breaker":
      return i.kind === "postback" && [t.payload].flat().includes(i.payload.trim()) ? { kw: i.payload } : undefined;
  }
}

/** The inbound kind a trigger listens to (for dry runs). */
export function triggerKind(t: Trigger): Inbound["kind"] {
  switch (t.type) {
    case "comment_keyword":
      return "comment";
    case "dm_keyword":
      return "dm";
    case "postback":
    case "ice_breaker":
      return "postback";
    default:
      return t.type;
  }
}
