import type { Config } from "../../config.js";
import type { DB } from "../../core/db.js";
import { UserError } from "../../core/errors.js";
import { D, H } from "../../core/time.js";
import type { Connector, DraftPayload, IncomingItem, SendRequest, SendResult } from "../../core/types.js";
import { loadAccount, type IgAccount } from "./account.js";
import { Graph, type Fetch } from "./graph.js";
import { IgPoller, type KV } from "./poll.js";
import { parseWebhook, type WebhookPayload } from "./webhook.js";

/** Send API `message` object: plain text, a button template, or text with quick replies. */
export function igMessage(text: string, payloadJson: string | null): Record<string, unknown> {
  const p = payloadJson ? (JSON.parse(payloadJson) as DraftPayload) : {};
  if (p.buttons?.length)
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons: p.buttons.map((b) => (b.url ? { type: "web_url", url: b.url, title: b.title } : { type: "postback", title: b.title, payload: b.payload })),
        },
      },
    };
  if (p.quick_replies?.length) return { text, quick_replies: p.quick_replies.map((q) => ({ content_type: "text", title: q.title, payload: q.payload })) };
  return { text };
}

export class MetaConnector implements Connector {
  net = "ig";
  limits = { dmWindowMs: 24 * H, humanAgentWindowMs: 7 * D, privateReplyWindowMs: 7 * D, dmMax: 1000, replyMax: 2200 };
  moderation = ["hide", "unhide", "delete"] as const;
  readonly graph: Graph;
  private poller: IgPoller;
  private usernames = new Map<string, string>();
  private cached?: { at: number; acct?: IgAccount };

  constructor(
    private db: DB,
    private cfg: Config,
    opts: { fetch?: Fetch; now?: () => number } = {},
  ) {
    this.graph = new Graph({ base: cfg.meta.graphBase, version: cfg.meta.graphVersion, appSecret: cfg.meta.appSecret, fetch: opts.fetch });
    const kv: KV = {
      get: (n) => (db.prepare("SELECT value FROM cursors WHERE name = ?").get(n) as { value: string } | undefined)?.value,
      set: (n, v) =>
        db.prepare("INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(n, v),
    };
    this.poller = new IgPoller(this.graph, () => this.account(), kv, {
      backfillDays: cfg.meta.backfillDays,
      mediaScan: 50,
      now: opts.now ?? Date.now,
    });
  }

  /** Connected account (decrypted token cached for a minute so re-auth is picked up quickly). */
  account(): IgAccount | undefined {
    if (!this.cached || Date.now() - this.cached.at > 60_000) this.cached = { at: Date.now(), acct: loadAccount(this.db, this.cfg.tokenEncKey) };
    return this.cached.acct;
  }

  resetAccountCache(): void {
    this.cached = undefined;
  }

  enabled(): boolean {
    return !!this.account();
  }

  async poll(scope?: string): Promise<IncomingItem[]> {
    if (!this.account()) return [];
    const out: IncomingItem[] = [];
    if (!scope || scope === "dm") out.push(...(await this.poller.conversations()));
    if (!scope || scope === "cm") out.push(...(await this.poller.comments()));
    if (!scope || scope === "mn") out.push(...(await this.poller.tags()));
    return out;
  }

  webhookItems(body: WebhookPayload) {
    return parseWebhook(body, this.account(), this.graph, this.usernames);
  }

  async send(req: SendRequest): Promise<SendResult> {
    const a = this.account();
    if (!a) throw new UserError("Instagram account not connected", 409);
    const { draft, item, thread } = req;
    const tok = a.pageToken;
    switch (draft.kind) {
      case "dm": {
        if (!req.recipientId) throw new UserError("missing DM recipient");
        const body: Record<string, unknown> = { recipient: { id: req.recipientId }, message: igMessage(draft.text ?? "", draft.payload) };
        if (req.humanAgent) Object.assign(body, { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
        else body.messaging_type = "RESPONSE";
        const r = await this.graph.post<{ message_id?: string; recipient_id?: string }>(`${a.pageId}/messages`, {}, tok, body);
        return { nativeId: r.message_id, raw: r };
      }
      case "private_reply": {
        if (!item) throw new UserError("missing comment");
        const r = await this.graph.post<{ message_id?: string }>(
          `${a.pageId}/messages`,
          {},
          tok,
          { recipient: { comment_id: item.native_id }, message: igMessage(draft.text ?? "", draft.payload) },
        );
        return { nativeId: r.message_id, raw: r };
      }
      case "reply": {
        if (!thread) throw new UserError("missing thread");
        if (thread.src === "ig.mn") return this.replyMention(a, thread.native_id, draft.text ?? "", item?.raw ?? null);
        // Instagram only nests one level: replies always go to the top-level comment.
        const r = await this.graph.post<{ id: string }>(`${thread.native_id}/replies`, { message: draft.text ?? "" }, tok);
        return { nativeId: r.id, raw: r };
      }
      case "hide":
      case "unhide": {
        if (!item) throw new UserError("missing comment");
        const r = await this.graph.post<{ success?: boolean }>(item.native_id, { hide: draft.kind === "hide" }, tok);
        return { raw: r };
      }
      case "delete": {
        if (!item) throw new UserError("missing comment");
        const r = await this.graph.del<{ success?: boolean }>(item.native_id, tok);
        return { raw: r };
      }
      default:
        throw new UserError(`${draft.kind} is not supported on Instagram`);
    }
  }

  private async replyMention(a: IgAccount, nid: string, text: string, raw: string | null): Promise<SendResult> {
    const meta = raw ? (JSON.parse(raw) as { media_id?: string; comment_id?: string }) : {};
    if (nid.startsWith("tag:")) throw new UserError("replying to photo tags is not supported by the API; comment on the post instead");
    const params: Record<string, string> = { message: text };
    if (meta.media_id) params.media_id = meta.media_id;
    if (nid.startsWith("mc:")) params.comment_id = nid.slice(3);
    if (!params.media_id) throw new UserError("mention is missing its media id");
    const r = await this.graph.post<{ id: string }>(`${a.igUserId}/mentions`, params, a.pageToken);
    return { nativeId: r.id, raw: r };
  }
}
