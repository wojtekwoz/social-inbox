import { FlowApi } from "../automations/api.js";
import type { EmailProviders } from "../automations/email.js";
import { Automations } from "../automations/engine.js";
import { recipientAllowed, sendLabel, type Config } from "../config.js";
import type { Logger } from "../log.js";
import { clamp, columnar, estimateTokens, fitRows, LIMITS, lines, trunc, type Row } from "./compact.js";
import type { DB } from "./db.js";
import { TransientError, UserError } from "./errors.js";
import { decodeCursor, encodeCursor, newId } from "./ids.js";
import type { In } from "./schemas.js";
import type * as S from "./schemas.js";
import { Store, type IngestResult, type ItemWithThread } from "./store.js";
import { age, H } from "./time.js";
import type { Connector, DraftKind, DraftPayload, DraftRow, IncomingItem, ItemRow, Label, Src, ThreadRow } from "./types.js";
import { replyWindow } from "./window.js";

const DEFAULT_COLS = ["id", "src", "t", "who", "age", "x", "lbl", "win"];
const ALLOWED_COLS = new Set([...DEFAULT_COLS, "on", "me", "ts", "read", "url", "nid", "raw"]);
const SYNC_MIN_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 5;
const CLOSING_MS = 6 * 60 * 60_000;

const arr = <T>(v: T | T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null);

export interface ServiceDeps {
  db: DB;
  config: Config;
  log: Logger;
  connectors?: Connector[];
  /** Configured email list providers for automations (see automations/email.ts). */
  email?: EmailProviders;
  now?: () => number;
}

export class Service {
  readonly store: Store;
  readonly db: DB;
  readonly config: Config;
  readonly log: Logger;
  readonly automations: Automations;
  readonly flows: FlowApi;
  private connectors = new Map<string, Connector>();
  private lastSync = new Map<string, number>();
  now: () => number;

  constructor(deps: ServiceDeps) {
    this.db = deps.db;
    this.store = new Store(deps.db);
    this.config = deps.config;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    for (const c of deps.connectors ?? []) this.connectors.set(c.net, c);
    this.automations = new Automations(this, deps.email);
    this.flows = new FlowApi(this, this.automations);
    this.recoverInterruptedSends();
  }

  /** Single ingest path for polls and webhooks: store (deduped), then evaluate new items once. */
  async ingest(items: IncomingItem[]): Promise<IngestResult> {
    const r = this.store.ingest(items, this.now());
    await this.automations.evaluate(r.ids);
    return r;
  }

  addConnector(c: Connector): void {
    this.connectors.set(c.net, c);
  }

  connector(net: string): Connector | undefined {
    return this.connectors.get(net);
  }

  // ---- rendering ------------------------------------------------------------

  private win(row: { src: string; me?: number; last_in_ts: number | null; net: string }): string | null {
    if (row.src !== "ig.dm" || row.me) return null;
    const c = this.connectors.get(row.net);
    if (!c) return null;
    return replyWindow(
      row.last_in_ts,
      { windowMs: c.limits.dmWindowMs, humanAgentWindowMs: c.limits.humanAgentWindowMs, humanAgent: this.config.meta.humanAgent },
      this.now(),
    ).label;
  }

  private compactItem(r: ItemWithThread, maxChars: number, cols: Set<string>): Row {
    const o: Row = {
      id: r.id,
      src: r.src,
      t: r.thread_id,
      who: r.me ? "me" : (r.who ?? "?"),
      age: age(r.ts, this.now()),
      x: trunc(r.text, maxChars) + (r.hidden ? " [hidden]" : ""),
      lbl: JSON.parse(r.labels),
      win: this.win(r),
    };
    if (cols.has("on") && r.post_id) o.on = `post:${r.post_id}`;
    if (cols.has("me") && r.me) o.me = 1;
    if (cols.has("ts")) o.ts = iso(r.ts);
    if (cols.has("read")) o.read = r.read;
    if (cols.has("url")) o.url = r.permalink;
    if (cols.has("nid")) o.nid = r.native_id;
    if (cols.has("raw")) o.raw = r.raw ? JSON.parse(r.raw) : null;
    return o;
  }

  // ---- read tools -----------------------------------------------------------

  overview() {
    const unread = this.store.unreadCounts();
    // Unanswered DMs whose reply window closes within CLOSING_MS (oldest first).
    const closing = this.store
      .openDmThreads()
      .flatMap((t) => {
        const c = this.connectors.get(t.net);
        if (!c) return [];
        const w = replyWindow(
          t.last_in_ts,
          { windowMs: c.limits.dmWindowMs, humanAgentWindowMs: c.limits.humanAgentWindowMs, humanAgent: this.config.meta.humanAgent },
          this.now(),
        );
        return w.open && w.leftMs <= CLOSING_MS ? [[t.id, t.who ?? "?", w.label]] : [];
      })
      .slice(0, 5);
    const drafts = Object.fromEntries(
      (
        this.db
          .prepare("SELECT status, count(*) AS n FROM drafts WHERE status IN ('pending','approved','failed') GROUP BY status")
          .all() as { status: string; n: number }[]
      ).map((r) => [r.status, r.n]),
    );
    const out: Row = { unread, closing, cursor: encodeCursor(this.store.head()) };
    if (Object.keys(drafts).length) out.drafts = drafts;
    const synced: Record<string, string> = {};
    for (const [net, c] of this.connectors) {
      const ts = Number(this.store.getCursor(`sync:${net}`) ?? 0);
      if (c.enabled && !c.enabled()) synced[net] = "not connected";
      else if (ts) synced[net] = age(ts, this.now());
    }
    if (Object.keys(synced).length) out.synced = synced;
    const auto = this.automations.overview();
    if (auto) out.auto = auto;
    out.send = sendLabel(this.config);
    return out;
  }

  list(p: In<typeof S.listShape>) {
    const limit = clamp(p.limit, LIMITS.limitDefault, 1, LIMITS.limitMax);
    const maxChars = clamp(p.maxChars, LIMITS.maxCharsDefault, 20, LIMITS.maxCharsMax);
    const cols = p.fields?.length ? ["id", ...p.fields.filter((f) => ALLOWED_COLS.has(f) && f !== "id")] : DEFAULT_COLS;
    const colSet = new Set(cols);
    const since = decodeCursor(p.since);
    const query = {
      sinceSeq: since,
      src: arr(p.src) as Src[] | undefined,
      lbl: arr(p.lbl),
      unread: p.unread ?? true,
      q: p.q,
      postId: p.on?.replace(/^post:/, ""),
      threadId: p.t,
      limit,
    };
    const { rows, more: dbMore } = this.store.list(query);
    const objs = rows.map((r) => this.compactItem(r, maxChars, colSet));
    const render = (n: number) => (p.fmt === "lines" ? lines(columnar(objs.slice(0, n), cols)) : columnar(objs.slice(0, n), cols));
    const kept = fitRows(objs, (o) => render(o.length));
    const more = dbMore || kept < objs.length;
    // Cursor: continue after the last row we returned; when caught up, jump to the head
    // so the next `since` call only returns genuinely new items.
    const next = more ? encodeCursor(rows[kept - 1]?.seq ?? since ?? 0) : encodeCursor(Math.max(this.store.head(), since ?? 0));
    const body = render(kept);
    const out: Row = p.fmt === "lines" ? { lines: body } : { ...(body as object) };
    out.next = next;
    out.more = more;
    // Unread items (same filters) beyond what this page returned.
    if (query.unread) out.unread_left = more ? this.store.count({ ...query, sinceSeq: rows[kept - 1]?.seq ?? since }) : 0;
    return out;
  }

  threadGet(p: In<typeof S.threadShape>) {
    const t = this.store.thread(p.t);
    if (!t) throw new UserError(`unknown thread ${p.t}`, 404);
    const last = clamp(p.last, LIMITS.threadLastDefault, 1, LIMITS.threadLastMax);
    const maxChars = clamp(p.maxChars, 400, 20, LIMITS.maxCharsMax);
    const msgs = this.store.threadItems(t.id, last);
    const dm = t.src === "ig.dm";
    const objs = msgs.map((m) => ({
      id: m.id,
      who: dm ? undefined : m.me ? "me" : m.who,
      age: age(m.ts, this.now()),
      x: trunc(m.text, maxChars) + (m.hidden ? " [hidden]" : ""),
      me: m.me ? 1 : undefined,
    }));
    const cols = dm ? ["id", "age", "x", "me"] : ["id", "who", "age", "x", "me"];
    const out: Row = { t: t.id, src: t.src, who: t.who ?? "?" };
    if (t.post_id) out.on = `post:${t.post_id}`;
    const w = this.win({ src: t.src, last_in_ts: t.last_in_ts, net: t.net });
    if (w) out.win = w;
    if (p.summary ?? true) {
      if (t.note) {
        out.sum = t.note;
        if (t.note_tags) out.tags = JSON.parse(t.note_tags);
        const fresh = (
          this.db.prepare("SELECT count(*) AS n FROM items WHERE thread_id = ? AND ts > ?").get(t.id, t.note_at ?? 0) as { n: number }
        ).n;
        if (fresh) out.new_since_sum = fresh;
      } else {
        const unanswered = t.last_in_ts && (!t.last_out_ts || t.last_out_ts < t.last_in_ts);
        out.sum = `${t.n_in} in/${t.n_out} out` + (t.last_in_ts ? `, last in ${age(t.last_in_ts, this.now())}` : "") + (unanswered ? ", unanswered" : "");
      }
    }
    const kept = fitRows(objs, (o) => ({ ...out, msgs: columnar(o, cols) }));
    // Keep the newest messages when trimming.
    out.msgs = columnar(objs.slice(objs.length - kept), cols);
    if (kept < objs.length || t.n_in + t.n_out > msgs.length) out.more = true;
    return out;
  }

  itemGet(p: In<typeof S.itemShape>) {
    const r = this.store.item(p.id);
    if (!r) throw new UserError(`unknown item ${p.id}`, 404);
    const cols = new Set(p.full ? ["on", "me", "ts", "url", "nid", "raw"] : ["on", "me"]);
    const o = this.compactItem(r, p.full ? 1_000_000 : LIMITS.maxCharsMax, cols);
    if (p.full) {
      o.x = r.text ?? "";
      o.tnid = this.store.thread(r.thread_id)?.native_id;
      if (r.author_id) o.uid = r.author_id;
      if (o.raw && estimateTokens(o.raw) > LIMITS.responseTokens) o.raw = "[too large]";
    }
    for (const k of Object.keys(o)) if (o[k] === null || (Array.isArray(o[k]) && !(o[k] as unknown[]).length)) delete o[k];
    return o;
  }

  search(p: In<typeof S.searchShape>) {
    const limit = clamp(p.limit, LIMITS.limitDefault, 1, LIMITS.limitMax);
    const { rows, more } = this.store.list({
      q: p.q,
      src: arr(p.src) as Src[] | undefined,
      unread: false,
      from: p.from ? Date.parse(p.from) : undefined,
      to: p.to ? Date.parse(p.to) : undefined,
      limit,
    });
    const objs = rows.map((r) => this.compactItem(r, LIMITS.maxCharsDefault, new Set()));
    const kept = fitRows(objs, (o) => columnar(o, DEFAULT_COLS));
    return { ...columnar(objs.slice(0, kept), DEFAULT_COLS), more: more || kept < objs.length };
  }

  mark(p: In<typeof S.markShape>, actor: string) {
    if (!p.ids?.length && !p.upTo) throw new UserError("pass ids or upTo");
    const n = this.store.mark({
      ids: p.ids,
      upToSeq: p.upTo ? decodeCursor(p.upTo) : undefined,
      read: p.read ?? (p.lbl_add || p.lbl_rm ? undefined : true),
      add: p.lbl_add as Label[] | undefined,
      rm: p.lbl_rm,
    });
    this.log.debug({ actor, n }, "mark");
    return { ok: true, n };
  }

  threadNote(p: In<typeof S.noteShape>, actor: string) {
    if (!this.store.thread(p.t)) throw new UserError(`unknown thread ${p.t}`, 404);
    this.store.setNote(p.t, p.summary.slice(0, 300), p.tags, this.now());
    this.store.audit(actor, "note", p.t);
    return { ok: true };
  }

  // ---- drafts ---------------------------------------------------------------

  private draftRow(d: string): DraftRow {
    const row = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(d) as DraftRow | undefined;
    if (!row) throw new UserError(`unknown draft ${d}`, 404);
    return row;
  }

  private compactDraft(r: DraftRow, preview = 120): Row {
    const o: Row = { d: r.id, st: r.status, k: r.kind, to: r.item_id ?? r.thread_id, age: age(r.created_at, this.now()) };
    if (r.text) o.x = trunc(r.text, preview);
    if (r.error) o.err = r.error;
    if (r.native_id) o.nid = r.native_id;
    if (r.flow_run_id) o.auto = r.flow_run_id;
    return o;
  }

  private byKey(key: string | undefined) {
    if (!key) return undefined;
    return this.db.prepare("SELECT * FROM drafts WHERE idem_key = ?").get(key) as DraftRow | undefined;
  }

  private resolveTarget(to: string): { item?: ItemWithThread; thread: ThreadRow } {
    if (to.startsWith("t")) {
      const thread = this.store.thread(to);
      if (!thread) throw new UserError(`unknown thread ${to}`, 404);
      return { thread };
    }
    const item = this.store.item(to);
    if (!item) throw new UserError(`unknown item ${to}`, 404);
    return { item, thread: this.store.thread(item.thread_id)! };
  }

  /**
   * Validates a reply draft; returns human-readable checks or throws with a clear reason.
   * `automation`: drafts created by a flow never get the HUMAN_AGENT window.
   */
  private checkReply(
    kind: DraftKind,
    text: string,
    item: ItemWithThread | undefined,
    thread: ThreadRow,
    excludeDraft?: string,
    automation = false,
  ): string[] {
    const c = this.connectors.get(thread.net);
    if (!c) throw new UserError(`no connector for ${thread.net}; cannot draft`, 409);
    const checks: string[] = [];
    const len = [...text].length;
    if (kind === "dm") {
      if (thread.src !== "ig.dm") throw new UserError(`kind dm needs a DM thread; ${thread.id} is ${thread.src}`);
      const humanAgent = this.config.meta.humanAgent && !automation;
      const w = replyWindow(
        thread.last_in_ts,
        { windowMs: c.limits.dmWindowMs, humanAgentWindowMs: c.limits.humanAgentWindowMs, humanAgent },
        this.now(),
      );
      if (!w.open) {
        const since = thread.last_in_ts ? age(thread.last_in_ts, this.now()) : "never";
        throw new UserError(
          `reply window closed: last message from ${thread.who ?? "user"} was ${since} ago (limit ${c.limits.dmWindowMs / H}h` +
            (humanAgent ? `, ${(c.limits.humanAgentWindowMs ?? 0) / H}h with HUMAN_AGENT` : "") +
            ")",
          422,
        );
      }
      checks.push(`win ${w.label}`);
      if (len > c.limits.dmMax) throw new UserError(`too long: ${len}/${c.limits.dmMax} chars`, 422);
      checks.push(`len ${len}/${c.limits.dmMax}`);
    } else if (kind === "reply") {
      if (thread.src === "ig.dm") throw new UserError(`use kind dm for DM threads`);
      if (len > c.limits.replyMax) throw new UserError(`too long: ${len}/${c.limits.replyMax} chars`, 422);
      checks.push(`len ${len}/${c.limits.replyMax}`);
    } else if (kind === "private_reply") {
      if (!item || item.src !== "ig.cm") throw new UserError("private_reply needs a comment item id (i…)");
      if (item.me) throw new UserError("cannot private-reply to your own comment");
      const winMs = c.limits.privateReplyWindowMs;
      if (!winMs) throw new UserError(`private replies are not supported on ${item.net}`);
      const left = item.ts + winMs - this.now();
      if (left <= 0) throw new UserError(`private reply window closed: comment is ${age(item.ts, this.now())} old (limit ${winMs / (24 * H)}d)`, 422);
      const dup = this.db
        .prepare(
          "SELECT id FROM drafts WHERE kind = 'private_reply' AND item_id = ? AND id != ? AND status IN ('pending','approved','sending','sent')",
        )
        .get(item.id, excludeDraft ?? "") as { id: string } | undefined;
      if (dup) throw new UserError(`only one private reply per comment; see ${dup.id}`, 409);
      checks.push(`win ${replyWindow(item.ts, { windowMs: winMs }, this.now()).label}`);
      if (len > c.limits.dmMax) throw new UserError(`too long: ${len}/${c.limits.dmMax} chars`, 422);
      checks.push(`len ${len}/${c.limits.dmMax}`);
    }
    return checks;
  }

  draftReply(p: In<typeof S.draftReplyShape>, actor: string) {
    return this.createDraft(p, actor);
  }

  /** Reply/DM draft creation shared by agents and automation flows (which add a payload and run id). */
  createDraft(
    p: { to: string; text: string; kind?: "reply" | "dm" | "private_reply"; key?: string; payload?: DraftPayload; flowRunId?: string },
    actor: string,
  ): Row & { d: string; dup?: boolean } {
    const existing = this.byKey(p.key);
    if (existing) return { ...this.compactDraft(existing), d: existing.id, ok: true, dup: true };
    const text = p.text.trim();
    if (!text) throw new UserError("empty text");
    const { item, thread } = this.resolveTarget(p.to);
    const kind: DraftKind = p.kind ?? (thread.src === "ig.dm" ? "dm" : "reply");
    const checks = this.checkReply(kind, text, item, thread, undefined, !!p.flowRunId);
    if (p.payload?.buttons?.length) checks.push(`buttons ${p.payload.buttons.length}`);
    if (p.payload?.quick_replies?.length) checks.push(`quick_replies ${p.payload.quick_replies.length}`);
    const id = newId(this.db, "d");
    this.db
      .prepare(
        `INSERT INTO drafts (id, kind, item_id, thread_id, text, status, idem_key, checks, created_by, created_at, flow_run_id, payload)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        item?.id ?? null,
        thread.id,
        text,
        p.key ?? null,
        JSON.stringify(checks),
        actor,
        this.now(),
        p.flowRunId ?? null,
        p.payload ? JSON.stringify(p.payload) : null,
      );
    this.store.audit(actor, "draft", id, { kind, to: p.to, ...(p.flowRunId ? { run: p.flowRunId } : {}) }, this.now());
    return { d: id, ok: true, checks, preview: trunc(text, 160) };
  }

  draftModeration(p: In<typeof S.draftModerationShape>, actor: string) {
    const existing = this.byKey(p.key);
    if (existing) return { ...this.compactDraft(existing), ok: true, dup: true };
    const item = this.store.item(p.id);
    if (!item) throw new UserError(`unknown item ${p.id} (moderation needs an item id)`, 404);
    const c = this.connectors.get(item.net);
    if (!c) throw new UserError(`no connector for ${item.net}`, 409);
    if (!c.moderation.includes(p.action)) throw new UserError(`${p.action} is not supported for ${item.src} (allowed: ${c.moderation.join(", ")})`);
    if (item.src === "ig.dm") throw new UserError("DMs cannot be moderated");
    if (p.action === "hide" && item.me) throw new UserError("cannot hide your own comment");
    if (p.banAuthor) throw new UserError("banAuthor is not supported on Instagram");
    const checks = [`${p.action} ${item.src}`];
    if (p.action === "hide" && item.hidden) checks.push("already hidden");
    const id = newId(this.db, "d");
    this.db
      .prepare(
        "INSERT INTO drafts (id, kind, item_id, thread_id, status, idem_key, checks, created_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      )
      .run(id, p.action, item.id, item.thread_id, p.key ?? null, JSON.stringify(checks), actor, this.now());
    this.store.audit(actor, "draft", id, { kind: p.action, to: p.id });
    return { d: id, ok: true, checks };
  }

  drafts(p: In<typeof S.draftsShape>) {
    const limit = clamp(p.limit, LIMITS.limitDefault, 1, LIMITS.limitMax);
    const rows = (
      p.status
        ? this.db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(p.status, limit)
        : this.db
            .prepare("SELECT * FROM drafts WHERE status IN ('pending','approved','sending','failed') ORDER BY created_at DESC LIMIT ?")
            .all(limit)
    ) as DraftRow[];
    const cols = ["d", "st", "k", "to", "age", "x", "err", "nid", "auto"];
    return columnar(rows.map((r) => this.compactDraft(r)), cols);
  }

  draftGet(d: string): Row {
    const r = this.draftRow(d);
    return { ...this.compactDraft(r, 2000), checks: r.checks ? JSON.parse(r.checks) : [] };
  }

  editDraft(d: string, text: string, actor: string) {
    const r = this.draftRow(d);
    if (r.status !== "pending") throw new UserError(`draft ${d} is ${r.status}; only pending drafts can be edited`, 409);
    if (!r.text) throw new UserError("moderation drafts have no text");
    const { item, thread } = this.resolveTarget(r.item_id ?? r.thread_id!);
    const checks = this.checkReply(r.kind, text.trim(), item, thread, d, !!r.flow_run_id);
    this.db.prepare("UPDATE drafts SET text = ?, checks = ? WHERE id = ?").run(text.trim(), JSON.stringify(checks), d);
    this.store.audit(actor, "edit", d);
    return { d, ok: true, checks };
  }

  /** Human approval (CLI / REST with an `approve`-scoped key), or agent-confirmed when configured. */
  approve(d: string, actor: string, confirmed?: { by: string; ref: string }) {
    if (confirmed && this.config.approval !== "agent-confirmed") throw new UserError("agent approval is disabled (APPROVAL=human)", 403);
    const r = this.draftRow(d);
    if (r.status === "approved" || r.status === "sent" || r.status === "sending") return { d, st: r.status, ok: true };
    if (r.status !== "pending") throw new UserError(`draft ${d} is ${r.status}`, 409);
    if (r.kind === "dm" && r.thread_id) {
      // The window may have closed while the draft waited.
      this.checkReply("dm", r.text ?? "", undefined, this.store.thread(r.thread_id)!, undefined, !!r.flow_run_id);
    }
    this.db
      .prepare("UPDATE drafts SET status = 'approved', approved_by = ?, approved_at = ?, confirmed = ? WHERE id = ? AND status = 'pending'")
      .run(actor, this.now(), confirmed ? JSON.stringify(confirmed) : null, d);
    this.store.audit(actor, "approve", d, confirmed);
    return { d, st: "approved", ok: true };
  }

  reject(d: string, actor: string) {
    const r = this.draftRow(d);
    if (!["pending", "approved"].includes(r.status)) throw new UserError(`draft ${d} is ${r.status}`, 409);
    this.db.prepare("UPDATE drafts SET status = 'rejected' WHERE id = ?").run(d);
    this.store.audit(actor, "reject", d);
    return { d, st: "rejected", ok: true };
  }

  /** Executes an approved draft exactly once. Re-calls return the stored result. */
  async sendApproved(d: string, actor: string): Promise<Row> {
    const r = this.draftRow(d);
    if (r.status === "sent") return { d, st: "sent", nid: r.native_id, dup: true };
    if (r.status === "sending") return { d, st: "sending" };
    if (r.status === "pending") throw new UserError(`draft ${d} is not approved; a human must approve it first (sinbox approve ${d})`, 409);
    if (r.status !== "approved") throw new UserError(`draft ${d} is ${r.status}`, 409);
    if (!this.config.sendingEnabled) throw new UserError("sending is disabled (SENDING_ENABLED=false); draft stays approved", 423);
    if (this.config.sendMode === "off") throw new UserError("sending is disabled (SEND_MODE=off); draft stays approved", 423);
    const sentLastHour = (
      this.db.prepare("SELECT count(*) AS n FROM audit WHERE action = 'sent' AND ts > ?").get(this.now() - H) as { n: number }
    ).n;
    if (sentLastHour >= this.config.maxSendsPerHour) throw new UserError(`send limit reached (${this.config.maxSendsPerHour}/h); retry later`, 429);

    const item = r.item_id ? this.store.item(r.item_id) : undefined;
    const thread = r.thread_id ? this.store.thread(r.thread_id) : undefined;
    if (!thread) throw new UserError(`draft ${d} target no longer exists`, 410);
    const c = this.connectors.get(thread.net);
    if (!c) throw new UserError(`no connector for ${thread.net}`, 409);

    // SEND_MODE=testers: only SEND_ALLOWLIST recipients. Final, so no retry.
    const to = this.recipient(r, item, thread);
    if (!recipientAllowed(this.config, to.id, to.who)) {
      const err = `recipient ${to.who ? `@${to.who.replace(/^@/, "")}` : (to.id ?? "unknown")} is not on SEND_ALLOWLIST (SEND_MODE=${this.config.sendMode})`;
      this.db.prepare("UPDATE drafts SET status = 'failed', error = ?, next_at = NULL WHERE id = ? AND status = 'approved'").run(err, d);
      this.store.audit(actor, "send_blocked", d, { kind: r.kind, err }, this.now());
      return { d, st: "failed", err, blocked: true };
    }

    let humanAgent = false;
    if (r.kind === "dm") {
      // Automation drafts never use the HUMAN_AGENT tag, even when the feature is on.
      const w = replyWindow(
        thread.last_in_ts,
        { windowMs: c.limits.dmWindowMs, humanAgentWindowMs: c.limits.humanAgentWindowMs, humanAgent: this.config.meta.humanAgent && !r.flow_run_id },
        this.now(),
      );
      if (!w.open) throw new UserError("reply window closed since approval; draft not sent", 422);
      humanAgent = w.humanAgent;
    }

    // Atomic claim: only one caller can move approved → sending.
    const claimed = this.db.prepare("UPDATE drafts SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'approved'").run(d).changes;
    if (!claimed) return { d, st: this.draftRow(d).status };

    const post = thread.post_id ? this.store.post(thread.post_id) : undefined;
    try {
      const res = await c.send({
        draft: r,
        item,
        thread,
        recipientId: thread.src === "ig.dm" ? thread.native_id.replace(/^dm:/, "") : undefined,
        postNativeId: post?.native_id,
        humanAgent,
      });
      const now = this.now();
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE drafts SET status = 'sent', sent_at = ?, native_id = ?, result = ?, error = NULL, next_at = NULL WHERE id = ?")
          .run(now, res.nativeId ?? null, res.raw === undefined ? null : JSON.stringify(res.raw), d);
        this.store.audit(actor, "sent", d, { kind: r.kind, nid: res.nativeId, approved_by: r.approved_by });
        this.applyLocalEffects(r, item, thread, res.nativeId, now);
        this.automations.onSent(r, now);
      })();
      return { d, st: "sent", nid: res.nativeId ?? null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = r.attempts + 1;
      if (e instanceof TransientError && attempts < MAX_ATTEMPTS) {
        const next = this.now() + Math.min(60 * 60_000, 30_000 * 2 ** (attempts - 1));
        this.db.prepare("UPDATE drafts SET status = 'approved', error = ?, next_at = ? WHERE id = ?").run(msg, next, d);
        this.store.audit(actor, "send_retry", d, { err: msg, attempts });
        return { d, st: "approved", err: msg, retry: true };
      }
      this.db.prepare("UPDATE drafts SET status = 'failed', error = ? WHERE id = ?").run(msg, d);
      this.store.audit(actor, "send_failed", d, { err: msg, attempts });
      return { d, st: "failed", err: msg };
    }
  }

  /** Who a draft reaches: the DM counterpart, or the author of the comment/mention being replied to or moderated. */
  private recipient(r: DraftRow, item: ItemRow | undefined, thread: ThreadRow): { id: string | null; who: string | null } {
    if (r.kind === "dm") return { id: thread.native_id.replace(/^dm:/, ""), who: thread.who };
    const src = item ?? thread;
    return { id: src.author_id, who: src.who };
  }

  private applyLocalEffects(r: DraftRow, item: ItemRow | undefined, thread: ThreadRow, nativeId: string | undefined, now: number) {
    if (r.kind === "hide" || r.kind === "unhide") return item && this.store.setFlags(item.id, { hidden: r.kind === "hide" });
    if (r.kind === "delete" || r.kind === "reject") return item && this.store.setFlags(item.id, { deleted: true });
    if (r.kind === "publish") return;
    // Outbound message: store it so the thread shows the reply (pollers dedupe on native id).
    if (r.kind === "private_reply") {
      if (item) this.store.mark({ ids: [item.id], read: true });
      return;
    }
    this.store.ingest(
      [
        {
          net: thread.net,
          nativeId: nativeId ?? `out:${r.id}`,
          src: thread.src,
          threadNativeId: thread.native_id,
          text: r.text ?? "",
          ts: now,
          me: true,
          parentNativeId: r.kind === "reply" ? thread.native_id : undefined,
        },
      ],
      now,
    );
  }

  /** A crash mid-send leaves drafts in "sending"; we can't know if the platform got it, so never auto-resend. */
  private recoverInterruptedSends() {
    const n = this.db
      .prepare("UPDATE drafts SET status = 'failed', error = 'interrupted during send; verify on the platform before re-drafting' WHERE status = 'sending'")
      .run().changes;
    if (n) this.log.warn({ n }, "drafts interrupted during send marked failed");
  }

  /** Outbox: retry approved drafts whose send hit a transient error. */
  async retryDue(): Promise<number> {
    const due = this.db
      .prepare("SELECT id FROM drafts WHERE status = 'approved' AND attempts > 0 AND next_at IS NOT NULL AND next_at <= ?")
      .all(this.now()) as { id: string }[];
    for (const { id } of due) {
      try {
        await this.sendApproved(id, "outbox");
      } catch (e) {
        this.log.warn({ d: id, err: (e as Error).message }, "outbox retry skipped");
      }
    }
    return due.length;
  }

  // ---- sync -----------------------------------------------------------------

  async sync(opts: { src?: Src; force?: boolean } = {}): Promise<Row> {
    const out: Row = {};
    const scope = opts.src?.split(".")[1];
    for (const c of this.connectors.values()) {
      if (c.enabled && !c.enabled()) {
        out[c.net] = { off: "not connected" };
        continue;
      }
      const key = `${c.net}:${scope ?? "*"}`;
      const last = this.lastSync.get(key) ?? 0;
      if (!opts.force && this.now() - last < SYNC_MIN_INTERVAL_MS) {
        out[c.net] = { skipped: `rate-limited, last sync ${age(last, this.now())} ago` };
        continue;
      }
      this.lastSync.set(key, this.now());
      try {
        const items = await c.poll(scope);
        const r = await this.ingest(items);
        this.store.setCursor(`sync:${c.net}`, String(this.now()));
        out[c.net] = { new: r.new, upd: r.updated };
      } catch (e) {
        this.log.warn({ net: c.net, err: (e as Error).message }, "sync failed");
        out[c.net] = { err: (e as Error).message };
      }
    }
    return out;
  }

  purge() {
    const r = this.store.purge(this.config.retentionRawDays, this.config.retentionTextDays, this.now());
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(this.now());
    return r;
  }
}
