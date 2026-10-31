import type { DB } from "./db.js";
import { headSeq, newId, nextSeq } from "./ids.js";
import { triage } from "./triage.js";
import type { IncomingItem, ItemRow, Label, Src, ThreadRow } from "./types.js";

export type ItemWithThread = ItemRow & { last_in_ts: number | null; t_src: Src };

export interface ListQuery {
  sinceSeq?: number;
  src?: Src[];
  lbl?: string[];
  unread: boolean;
  q?: string;
  postId?: string;
  threadId?: string;
  from?: number;
  to?: number;
  limit: number;
}

export interface IngestResult {
  new: number;
  updated: number;
  ids: string[];
}

/** Quote every term so user input can never be parsed as FTS5 syntax. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export class Store {
  constructor(public db: DB) {}

  // ---- ingest -------------------------------------------------------------

  ingest(items: IncomingItem[], now = Date.now()): IngestResult {
    const res: IngestResult = { new: 0, updated: 0, ids: [] };
    const sorted = [...items].sort((a, b) => a.ts - b.ts);
    this.db.transaction(() => {
      for (const it of sorted) {
        const r = this.ingestOne(it, now);
        if (typeof r === "object") (res.new++, res.ids.push(r.id));
        else if (r === "updated") res.updated++;
      }
    })();
    return res;
  }

  private upsertPost(net: string, p: NonNullable<IncomingItem["post"]>): string {
    const ex = this.db.prepare("SELECT id FROM posts WHERE net = ? AND native_id = ?").get(net, p.nativeId) as
      | { id: string }
      | undefined;
    if (ex) {
      this.db
        .prepare(
          "UPDATE posts SET permalink = coalesce(?, permalink), caption = coalesce(?, caption), ts = coalesce(?, ts), cm_count = coalesce(?, cm_count) WHERE id = ?",
        )
        .run(p.permalink ?? null, p.caption ?? null, p.ts ?? null, p.cmCount ?? null, ex.id);
      return ex.id;
    }
    const id = newId(this.db, "p");
    this.db
      .prepare("INSERT INTO posts (id, net, native_id, permalink, caption, ts, cm_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, net, p.nativeId, p.permalink ?? null, p.caption ?? null, p.ts ?? null, p.cmCount ?? null);
    return id;
  }

  private ingestOne(it: IncomingItem, now: number): { id: string } | "updated" | "same" {
    const postId = it.post ? this.upsertPost(it.net, it.post) : null;
    const existing = this.db.prepare("SELECT * FROM items WHERE net = ? AND native_id = ?").get(it.net, it.nativeId) as
      | ItemRow
      | undefined;
    if (existing) {
      const text = it.text ?? existing.text;
      const who = it.who ?? existing.who;
      const hidden = it.hidden === undefined ? existing.hidden : it.hidden ? 1 : 0;
      if (text === existing.text && who === existing.who && hidden === existing.hidden) return "same";
      this.db
        .prepare("UPDATE items SET text = ?, who = ?, hidden = ?, raw = coalesce(?, raw) WHERE id = ?")
        .run(text, who, hidden, it.raw === undefined ? null : JSON.stringify(it.raw), existing.id);
      if (who && !existing.me) this.db.prepare("UPDATE threads SET who = ? WHERE id = ? AND (who IS NULL OR who = author_id)").run(who, existing.thread_id);
      return "updated";
    }

    let thread = this.db
      .prepare("SELECT * FROM threads WHERE net = ? AND native_id = ?")
      .get(it.net, it.threadNativeId) as ThreadRow | undefined;
    if (!thread) {
      const tid = newId(this.db, "t");
      this.db
        .prepare("INSERT INTO threads (id, net, native_id, src, who, author_id, post_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(tid, it.net, it.threadNativeId, it.src, it.me ? null : (it.who ?? null), it.me ? null : (it.authorId ?? null), postId);
      thread = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(tid) as ThreadRow;
    }

    const id = newId(this.db, "i");
    const me = it.me ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO items (id, seq, net, native_id, src, thread_id, author_id, who, text, ts, me, post_id, parent_nid,
                            permalink, hidden, read, labels, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        nextSeq(this.db),
        it.net,
        it.nativeId,
        it.src,
        thread.id,
        it.authorId ?? null,
        it.who ?? null,
        it.text ?? null,
        it.ts,
        me,
        postId,
        it.parentNativeId ?? null,
        it.permalink ?? null,
        it.hidden ? 1 : 0,
        me,
        JSON.stringify(triage(it.text, !!it.me)),
        it.raw === undefined ? null : JSON.stringify(it.raw),
        now,
      );

    if (me) {
      this.db
        .prepare("UPDATE threads SET n_out = n_out + 1, last_out_ts = max(coalesce(last_out_ts, 0), ?), last_ts = max(coalesce(last_ts, 0), ?) WHERE id = ?")
        .run(it.ts, it.ts, thread.id);
      // wozu answered: earlier inbound items in this thread are handled.
      this.db.prepare("UPDATE items SET read = 1 WHERE thread_id = ? AND me = 0 AND ts <= ? AND read = 0").run(thread.id, it.ts);
    } else {
      this.db
        .prepare(
          `UPDATE threads SET n_in = n_in + 1, last_in_ts = max(coalesce(last_in_ts, 0), ?), last_ts = max(coalesce(last_ts, 0), ?),
                              who = coalesce(who, ?), author_id = coalesce(author_id, ?) WHERE id = ?`,
        )
        .run(it.ts, it.ts, it.who ?? null, it.authorId ?? null, thread.id);
    }
    return { id };
  }

  // ---- reads --------------------------------------------------------------

  head(): number {
    return headSeq(this.db);
  }

  item(id: string): ItemWithThread | undefined {
    return this.db
      .prepare("SELECT i.*, t.last_in_ts, t.src AS t_src FROM items i JOIN threads t ON t.id = i.thread_id WHERE i.id = ?")
      .get(id) as ItemWithThread | undefined;
  }

  thread(id: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  }

  post(id: string): { id: string; native_id: string; permalink: string | null; net: string } | undefined {
    return this.db.prepare("SELECT id, native_id, permalink, net FROM posts WHERE id = ?").get(id) as never;
  }

  threadItems(threadId: string, last: number): ItemRow[] {
    const rows = this.db
      .prepare("SELECT * FROM items WHERE thread_id = ? AND deleted = 0 ORDER BY ts DESC, seq DESC LIMIT ?")
      .all(threadId, last) as ItemRow[];
    return rows.reverse();
  }

  list(q: ListQuery): { rows: ItemWithThread[]; more: boolean } {
    const { where, args } = this.where(q);
    const rows = this.db
      .prepare(
        `SELECT i.*, t.last_in_ts, t.src AS t_src FROM items i JOIN threads t ON t.id = i.thread_id
         WHERE ${where} ORDER BY i.seq ASC LIMIT ?`,
      )
      .all(...args, q.limit + 1) as ItemWithThread[];
    const more = rows.length > q.limit;
    return { rows: more ? rows.slice(0, q.limit) : rows, more };
  }

  count(q: Omit<ListQuery, "limit">): number {
    const { where, args } = this.where(q);
    return (this.db.prepare(`SELECT count(*) AS n FROM items i WHERE ${where}`).get(...args) as { n: number }).n;
  }

  private where(q: Omit<ListQuery, "limit">): { where: string; args: unknown[] } {
    const where: string[] = ["i.deleted = 0"];
    const args: unknown[] = [];
    if (q.sinceSeq !== undefined) (where.push("i.seq > ?"), args.push(q.sinceSeq));
    if (q.unread) where.push("i.read = 0");
    if (q.src?.length) (where.push(`i.src IN (${q.src.map(() => "?").join(",")})`), args.push(...q.src));
    if (q.lbl?.length)
      (where.push(`EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value IN (${q.lbl.map(() => "?").join(",")}))`),
        args.push(...q.lbl));
    if (q.postId) (where.push("i.post_id = ?"), args.push(q.postId));
    if (q.threadId) (where.push("i.thread_id = ?"), args.push(q.threadId));
    if (q.from !== undefined) (where.push("i.ts >= ?"), args.push(q.from));
    if (q.to !== undefined) (where.push("i.ts <= ?"), args.push(q.to));
    if (q.q) (where.push("i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)"), args.push(ftsQuery(q.q)));
    return { where: where.join(" AND "), args };
  }

  unreadCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT src, count(*) AS n FROM items WHERE read = 0 AND deleted = 0 GROUP BY src")
      .all() as { src: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.src, r.n]));
  }

  /** DM threads with an unanswered inbound message. */
  openDmThreads(): ThreadRow[] {
    return this.db
      .prepare(
        "SELECT * FROM threads WHERE src = 'ig.dm' AND last_in_ts IS NOT NULL AND (last_out_ts IS NULL OR last_out_ts < last_in_ts) ORDER BY last_in_ts ASC",
      )
      .all() as ThreadRow[];
  }

  // ---- writes -------------------------------------------------------------

  mark(opts: { ids?: string[]; upToSeq?: number; read?: boolean; add?: Label[]; rm?: string[] }): number {
    let n = 0;
    this.db.transaction(() => {
      const targets: string[] = [];
      if (opts.ids?.length) {
        for (const id of opts.ids) {
          if (id.startsWith("t")) {
            const rows = this.db.prepare("SELECT id FROM items WHERE thread_id = ?").all(id) as { id: string }[];
            targets.push(...rows.map((r) => r.id));
          } else targets.push(id);
        }
      }
      if (opts.upToSeq !== undefined) {
        const rows = this.db.prepare("SELECT id FROM items WHERE seq <= ? AND read = 0").all(opts.upToSeq) as { id: string }[];
        targets.push(...rows.map((r) => r.id));
      }
      const get = this.db.prepare("SELECT labels, read FROM items WHERE id = ?");
      const upd = this.db.prepare("UPDATE items SET read = ?, labels = ? WHERE id = ?");
      for (const id of new Set(targets)) {
        const row = get.get(id) as { labels: string; read: number } | undefined;
        if (!row) continue;
        let labels = JSON.parse(row.labels) as string[];
        if (opts.add) labels = [...new Set([...labels, ...opts.add])];
        if (opts.rm) labels = labels.filter((l) => !opts.rm!.includes(l));
        const read = opts.read === undefined ? (opts.upToSeq !== undefined ? 1 : row.read) : opts.read ? 1 : 0;
        upd.run(read, JSON.stringify(labels), id);
        n++;
      }
    })();
    return n;
  }

  setNote(threadId: string, note: string, tags: string[] | undefined, now = Date.now()): void {
    this.db
      .prepare("UPDATE threads SET note = ?, note_tags = ?, note_at = ? WHERE id = ?")
      .run(note, tags ? JSON.stringify(tags) : null, now, threadId);
  }

  setFlags(itemId: string, f: { hidden?: boolean; deleted?: boolean }): void {
    if (f.hidden !== undefined) this.db.prepare("UPDATE items SET hidden = ? WHERE id = ?").run(f.hidden ? 1 : 0, itemId);
    if (f.deleted !== undefined) this.db.prepare("UPDATE items SET deleted = ? WHERE id = ?").run(f.deleted ? 1 : 0, itemId);
  }

  getCursor(name: string): string | undefined {
    return (this.db.prepare("SELECT value FROM cursors WHERE name = ?").get(name) as { value: string } | undefined)?.value;
  }

  setCursor(name: string, value: string): void {
    this.db
      .prepare("INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .run(name, value);
  }

  audit(actor: string, action: string, ref?: string, detail?: unknown, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO audit (ts, actor, action, ref, detail) VALUES (?, ?, ?, ?, ?)")
      .run(now, actor, action, ref ?? null, detail === undefined ? null : JSON.stringify(detail));
  }

  // ---- privacy / retention ------------------------------------------------

  /** Delete every item (and orphaned DM thread) authored by, or in a DM with, a given native user id. */
  forgetPerson(net: string, authorId: string): number {
    let n = 0;
    this.db.transaction(() => {
      const threads = this.db
        .prepare("SELECT id FROM threads WHERE net = ? AND (author_id = ? OR native_id = ?)")
        .all(net, authorId, `dm:${authorId}`) as { id: string }[];
      const dmThreads = threads.filter((t) => this.thread(t.id)?.src === "ig.dm").map((t) => t.id);
      for (const t of dmThreads) {
        this.db.prepare("UPDATE drafts SET item_id = NULL, thread_id = NULL, text = NULL WHERE thread_id = ?").run(t);
        n += this.db.prepare("DELETE FROM items WHERE thread_id = ?").run(t).changes;
        this.db.prepare("DELETE FROM threads WHERE id = ?").run(t);
      }
      const own = this.db.prepare("SELECT id FROM items WHERE net = ? AND author_id = ?").all(net, authorId) as { id: string }[];
      for (const { id } of own) {
        this.db.prepare("UPDATE drafts SET item_id = NULL, text = NULL WHERE item_id = ?").run(id);
        n += this.db.prepare("DELETE FROM items WHERE id = ?").run(id).changes;
      }
      this.db
        .prepare("UPDATE threads SET who = NULL, author_id = NULL WHERE net = ? AND author_id = ?")
        .run(net, authorId);
      // Automation runs hold captured emails. Opt-outs are kept so the person is never messaged again.
      this.db.prepare("DELETE FROM flow_runs WHERE net = ? AND contact_id = ?").run(net, authorId);
    })();
    return n;
  }

  exportPerson(net: string, authorId: string): ItemRow[] {
    return this.db
      .prepare(
        "SELECT i.* FROM items i JOIN threads t ON t.id = i.thread_id WHERE i.net = ? AND (i.author_id = ? OR t.native_id = ?) ORDER BY i.ts",
      )
      .all(net, authorId, `dm:${authorId}`) as ItemRow[];
  }

  purge(rawDays: number, textDays: number, now = Date.now()): { raw: number; text: number } {
    const raw = this.db.prepare("UPDATE items SET raw = NULL WHERE raw IS NOT NULL AND created_at < ?").run(now - rawDays * 864e5).changes;
    const text = this.db
      .prepare("UPDATE items SET text = NULL, who = NULL WHERE text IS NOT NULL AND ts < ?")
      .run(now - textDays * 864e5).changes;
    return { raw, text };
  }
}
