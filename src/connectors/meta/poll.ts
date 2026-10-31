import type { IncomingItem } from "../../core/types.js";
import type { IgAccount } from "./account.js";
import type { Graph } from "./graph.js";

// Pollers for Instagram via the Page-linked (Facebook Login for Business) API.
// They work in dev mode, where webhooks do not fire, and back up webhooks in production.

export interface KV {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

interface Party {
  id: string;
  username?: string;
}
interface GMessage {
  id: string;
  created_time: string;
  from?: Party;
  to?: { data: Party[] };
  message?: string;
  attachments?: { data: { mime_type?: string; image_data?: unknown; video_data?: unknown }[] };
  story?: { mention?: unknown; reply_to?: unknown };
  is_unsupported?: boolean;
}
interface GConversation {
  id: string;
  updated_time: string;
  participants?: { data: Party[] };
}
interface GMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  comments_count?: number;
  username?: string;
}
interface GComment {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  from?: Party;
  hidden?: boolean;
  replies?: { data: GComment[] };
}

const at = (s: string | undefined) => (s ? Date.parse(s) : Date.now());
const handle = (u?: string) => (u ? `@${u}` : undefined);
/** Overlap re-fetch so messages arriving out of order are not missed (dedupe makes it free). */
const OVERLAP_MS = 10 * 60_000;

export function messageText(m: { message?: string; text?: string; attachments?: unknown; story?: unknown; is_unsupported?: boolean }): string {
  const t = m.message ?? m.text;
  if (t) return t;
  if (m.story) return "[story reply/mention]";
  const att = m.attachments as { data?: { mime_type?: string }[] } | { type?: string }[] | undefined;
  const list = Array.isArray(att) ? att : (att?.data ?? []);
  if (list.length) {
    const first = list[0] as { mime_type?: string; type?: string };
    return `[${first.type ?? first.mime_type?.split("/")[0] ?? "attachment"}]`;
  }
  return m.is_unsupported ? "[unsupported message]" : "";
}

export class IgPoller {
  constructor(
    private graph: Graph,
    private acct: () => IgAccount | undefined,
    private kv: KV,
    private opts: { backfillDays: number; mediaScan: number; now: () => number },
  ) {}

  private cutoff(key: string): number {
    const c = this.kv.get(key);
    return c ? Number(c) - OVERLAP_MS : this.opts.now() - this.opts.backfillDays * 864e5;
  }

  async conversations(): Promise<IncomingItem[]> {
    const a = this.acct();
    if (!a) return [];
    const key = "ig:conv";
    const since = this.cutoff(key);
    let newest = Number(this.kv.get(key) ?? 0);
    const out: IncomingItem[] = [];
    const convs = this.graph.paginate<GConversation>(
      `${a.pageId}/conversations`,
      { platform: "instagram", fields: "id,updated_time,participants", limit: 25 },
      a.pageToken,
      4,
    );
    for await (const c of convs) {
      const updated = at(c.updated_time);
      if (updated < since) break; // sorted newest first
      newest = Math.max(newest, updated);
      const other = c.participants?.data.find((p) => p.id !== a.igUserId && p.username !== a.username);
      if (!other) continue;
      const msgs = this.graph.paginate<GMessage>(
        `${c.id}/messages`,
        { fields: "id,created_time,from,to,message,attachments,story,is_unsupported", limit: 25 },
        a.pageToken,
        4,
      );
      for await (const m of msgs) {
        const ts = at(m.created_time);
        if (ts < since) break;
        const me = m.from?.id === a.igUserId || m.from?.username === a.username;
        out.push({
          net: "ig",
          nativeId: m.id,
          src: "ig.dm",
          threadNativeId: `dm:${other.id}`,
          authorId: me ? a.igUserId : other.id,
          who: me ? undefined : handle(m.from?.username ?? other.username),
          text: messageText(m),
          ts,
          me,
          raw: m,
        });
      }
    }
    if (newest) this.kv.set(key, String(newest));
    return out;
  }

  async comments(): Promise<IncomingItem[]> {
    const a = this.acct();
    if (!a) return [];
    const since = this.opts.now() - this.opts.backfillDays * 864e5;
    const out: IncomingItem[] = [];
    // One cheap call returns comment counts for recent media; we only fetch comments where the count moved.
    const media = await this.graph.get<{ data: GMedia[] }>(
      `${a.igUserId}/media`,
      { fields: "id,caption,permalink,timestamp,comments_count", limit: this.opts.mediaScan },
      a.pageToken,
    );
    for (const m of media.data ?? []) {
      const count = m.comments_count ?? 0;
      const k = `ig:mc:${m.id}`;
      if (String(count) === this.kv.get(k)) continue;
      const post = { nativeId: m.id, permalink: m.permalink, caption: m.caption?.slice(0, 200), ts: at(m.timestamp), cmCount: count };
      if (count > 0) {
        const fields = "id,text,timestamp,username,from,hidden,replies{id,text,timestamp,username,from,hidden}";
        for await (const c of this.graph.paginate<GComment>(`${m.id}/comments`, { fields, limit: 50 }, a.pageToken, 4)) {
          const push = (x: GComment, parent?: string) => {
            const ts = at(x.timestamp);
            if (ts < since) return;
            const me = x.from?.id === a.igUserId || x.username === a.username;
            out.push({
              net: "ig",
              nativeId: x.id,
              src: "ig.cm",
              threadNativeId: parent ?? x.id,
              authorId: x.from?.id,
              who: handle(x.username ?? x.from?.username),
              text: x.text ?? "",
              ts,
              me,
              hidden: x.hidden,
              parentNativeId: parent,
              post,
              permalink: m.permalink,
              raw: { ...x, replies: undefined, media_id: m.id },
            });
          };
          push(c);
          for (const r of c.replies?.data ?? []) push(r, c.id);
        }
      }
      this.kv.set(k, String(count));
    }
    return out;
  }

  /** Media where the account was tagged (photo tags). Read-only. */
  async tags(): Promise<IncomingItem[]> {
    const a = this.acct();
    if (!a) return [];
    const since = this.cutoff("ig:tags");
    const res = await this.graph.get<{ data: GMedia[] }>(
      `${a.igUserId}/tags`,
      { fields: "id,caption,permalink,timestamp,username", limit: 25 },
      a.pageToken,
    );
    const out: IncomingItem[] = [];
    for (const m of res.data ?? []) {
      const ts = at(m.timestamp);
      if (ts < since) continue;
      out.push({
        net: "ig",
        nativeId: `tag:${m.id}`,
        src: "ig.mn",
        threadNativeId: `tag:${m.id}`,
        who: handle(m.username),
        text: m.caption ?? "[tagged you in a post]",
        ts,
        permalink: m.permalink,
        raw: m,
      });
    }
    this.kv.set("ig:tags", String(this.opts.now()));
    return out;
  }
}
