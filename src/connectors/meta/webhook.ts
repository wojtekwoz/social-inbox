import { createHmac } from "node:crypto";
import { safeEqual } from "../../core/crypto.js";
import type { IncomingItem } from "../../core/types.js";
import type { IgAccount } from "./account.js";
import type { Graph } from "./graph.js";
import { messageText } from "./poll.js";

// Meta webhooks: GET verification handshake + signed POST deliveries.

/** Verifies `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: Buffer | string, header: string | undefined | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice(7), expected);
}

export function verifyChallenge(q: URLSearchParams, verifyToken: string | undefined): string | undefined {
  if (!verifyToken) return undefined;
  if (q.get("hub.mode") !== "subscribe") return undefined;
  if (!safeEqual(q.get("hub.verify_token") ?? "", verifyToken)) return undefined;
  return q.get("hub.challenge") ?? undefined;
}

interface Messaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: { mid: string; text?: string; is_echo?: boolean; is_deleted?: boolean; attachments?: unknown };
}
interface Change {
  field: string;
  value: Record<string, unknown>;
}
interface Entry {
  id: string;
  time: number;
  messaging?: Messaging[];
  changes?: Change[];
}
export interface WebhookPayload {
  object: string;
  entry?: Entry[];
}

/** Turns a webhook delivery into items. Graph lookups (mentions, usernames) are best-effort. */
export async function parseWebhook(
  body: WebhookPayload,
  acct: IgAccount | undefined,
  graph: Graph | undefined,
  usernames: Map<string, string>,
): Promise<{ items: IncomingItem[]; ignored: number }> {
  const items: IncomingItem[] = [];
  let ignored = 0;
  if (body.object !== "instagram" && body.object !== "page") return { items, ignored: 1 };
  const self = acct?.igUserId;

  for (const e of body.entry ?? []) {
    const entryTs = e.time > 1e12 ? e.time : e.time * 1000;
    for (const m of e.messaging ?? []) {
      if (!m.message || m.message.is_deleted) {
        ignored++; // messaging_seen, reactions, deletes
        continue;
      }
      const me = !!m.message.is_echo || m.sender.id === self || m.sender.id === e.id;
      const other = me ? m.recipient.id : m.sender.id;
      let who = usernames.get(other);
      if (!who && !me && acct && graph) {
        try {
          const p = await graph.get<{ username?: string }>(other, { fields: "username" }, acct.pageToken);
          if (p.username) usernames.set(other, (who = `@${p.username}`));
        } catch {
          /* profile lookup needs consent in some cases; the poller fills names later */
        }
      }
      items.push({
        net: "ig",
        nativeId: m.message.mid,
        src: "ig.dm",
        threadNativeId: `dm:${other}`,
        authorId: me ? self : other,
        who: me ? undefined : who,
        text: messageText(m.message),
        ts: m.timestamp,
        me,
        raw: m,
      });
    }

    for (const c of e.changes ?? []) {
      const v = c.value;
      if (c.field === "comments" || c.field === "live_comments") {
        const from = v.from as { id?: string; username?: string } | undefined;
        const media = v.media as { id?: string } | undefined;
        const parent = v.parent_id as string | undefined;
        items.push({
          net: "ig",
          nativeId: String(v.id),
          src: "ig.cm",
          threadNativeId: parent ?? String(v.id),
          authorId: from?.id,
          who: from?.username ? `@${from.username}` : undefined,
          text: String(v.text ?? ""),
          ts: entryTs,
          me: !!self && from?.id === self,
          parentNativeId: parent,
          post: media?.id ? { nativeId: media.id } : undefined,
          raw: v,
        });
      } else if (c.field === "mentions") {
        const mediaId = v.media_id as string | undefined;
        const commentId = v.comment_id as string | undefined;
        let text = commentId ? "[mentioned you in a comment]" : "[mentioned you in a caption]";
        let who: string | undefined;
        let ts = entryTs;
        let permalink: string | undefined;
        if (acct && graph) {
          try {
            if (commentId) {
              const r = await graph.get<{ mentioned_comment?: { text?: string; username?: string; timestamp?: string } }>(
                acct.igUserId,
                { fields: `mentioned_comment.comment_id(${commentId}){text,username,timestamp}` },
                acct.pageToken,
              );
              text = r.mentioned_comment?.text ?? text;
              who = r.mentioned_comment?.username;
              if (r.mentioned_comment?.timestamp) ts = Date.parse(r.mentioned_comment.timestamp);
            } else if (mediaId) {
              const r = await graph.get<{ mentioned_media?: { caption?: string; username?: string; timestamp?: string; permalink?: string } }>(
                acct.igUserId,
                { fields: `mentioned_media.media_id(${mediaId}){caption,username,timestamp,permalink}` },
                acct.pageToken,
              );
              text = r.mentioned_media?.caption ?? text;
              who = r.mentioned_media?.username;
              permalink = r.mentioned_media?.permalink;
              if (r.mentioned_media?.timestamp) ts = Date.parse(r.mentioned_media.timestamp);
            }
          } catch {
            /* keep placeholder text */
          }
        }
        const nid = commentId ? `mc:${commentId}` : `mm:${mediaId}`;
        items.push({
          net: "ig",
          nativeId: nid,
          src: "ig.mn",
          threadNativeId: nid,
          who: who ? `@${who}` : undefined,
          text,
          ts,
          permalink,
          raw: { ...v, media_id: mediaId, comment_id: commentId },
        });
      } else {
        ignored++;
      }
    }
  }
  return { items, ignored };
}
