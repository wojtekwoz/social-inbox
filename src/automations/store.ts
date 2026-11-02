import type { DB } from "../core/db.js";
import { newId } from "../core/ids.js";
import type { FlowInput, Step, Trigger } from "./schema.js";

// SQL for flows, runs, the metrics log, opt-outs and the evaluation ledger.

export type RunState = "active" | "waiting_input" | "done" | "stopped" | "failed";
export type EventType =
  | "triggered"
  | "drafted"
  | "sent"
  | "public_reply"
  | "button_tap"
  | "quick_reply"
  | "email_captured"
  | "email_pushed"
  | "skipped"
  | "failed";

interface FlowRow {
  id: string;
  name: string;
  enabled: number;
  mode: "draft" | "auto";
  priority: number;
  trigger: string;
  steps: string;
  rr: number;
  enabled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Flow {
  id: string;
  name: string;
  enabled: boolean;
  mode: "draft" | "auto";
  priority: number;
  trigger: Trigger;
  steps: Step[];
  rr: number;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunVars {
  email?: string;
  /** Postback / quick-reply payloads a tap must match before window steps run. */
  tap?: string[];
  /** Waiting for an email: index of the ask_email step and invalid replies so far. */
  ask?: { step: number; tries: number };
  /** Follow status, only when known (is_user_follow_business is deferred). */
  follows?: boolean;
}

export interface Run {
  id: string;
  flow_id: string;
  net: string;
  contact_id: string;
  thread_id: string | null;
  item_id: string;
  media_id: string | null;
  step: number;
  state: RunState;
  vars: RunVars;
  created_at: number;
  updated_at: number;
}

const toFlow = (r: FlowRow): Flow => ({
  id: r.id,
  name: r.name,
  enabled: !!r.enabled,
  mode: r.mode,
  priority: r.priority,
  trigger: JSON.parse(r.trigger),
  steps: JSON.parse(r.steps),
  rr: r.rr,
  enabledAt: r.enabled_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: Omit<Run, "vars"> & { vars: string }): Run => ({ ...r, vars: JSON.parse(r.vars) });

export class FlowStore {
  constructor(private db: DB) {}

  // ---- flows ----------------------------------------------------------------

  flows(enabledOnly = false): Flow[] {
    const rows = this.db
      .prepare(`SELECT * FROM flows ${enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY priority ASC, rowid ASC`)
      .all() as FlowRow[];
    return rows.map(toFlow);
  }

  flow(id: string): Flow | undefined {
    const r = this.db.prepare("SELECT * FROM flows WHERE id = ?").get(id) as FlowRow | undefined;
    return r && toFlow(r);
  }

  insert(f: FlowInput, now: number): string {
    const id = newId(this.db, "f");
    this.db
      .prepare(
        `INSERT INTO flows (id, name, enabled, mode, priority, trigger, steps, enabled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.name, f.enabled ? 1 : 0, f.mode ?? "draft", f.priority ?? 100, JSON.stringify(f.trigger), JSON.stringify(f.steps), f.enabled ? now : null, now, now);
    return id;
  }

  update(prev: Flow, f: FlowInput, now: number): void {
    const enabled = f.enabled ?? prev.enabled;
    this.db
      .prepare("UPDATE flows SET name = ?, enabled = ?, mode = ?, priority = ?, trigger = ?, steps = ?, enabled_at = ?, updated_at = ? WHERE id = ?")
      .run(
        f.name,
        enabled ? 1 : 0,
        f.mode ?? prev.mode,
        f.priority ?? prev.priority,
        JSON.stringify(f.trigger),
        JSON.stringify(f.steps),
        enabled ? (prev.enabled ? prev.enabledAt : now) : null,
        now,
        prev.id,
      );
  }

  setEnabled(id: string, on: boolean, now: number): void {
    this.db
      .prepare("UPDATE flows SET enabled = ?, enabled_at = CASE WHEN ? THEN coalesce(CASE WHEN enabled = 1 THEN enabled_at END, ?) END, updated_at = ? WHERE id = ?")
      .run(on ? 1 : 0, on ? 1 : 0, now, now, id);
  }

  /** Atomically takes the next round-robin slot. */
  nextRr(id: string): number {
    return (this.db.prepare("UPDATE flows SET rr = rr + 1 WHERE id = ? RETURNING rr - 1 AS n").get(id) as { n: number }).n;
  }

  // ---- runs -----------------------------------------------------------------

  createRun(r: Pick<Run, "flow_id" | "net" | "contact_id" | "thread_id" | "item_id" | "media_id">, now: number): Run | undefined {
    const id = newId(this.db, "r");
    const changes = this.db
      .prepare(
        `INSERT OR IGNORE INTO flow_runs (id, flow_id, net, contact_id, thread_id, item_id, media_id, step, state, vars, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', '{}', ?, ?)`,
      )
      .run(id, r.flow_id, r.net, r.contact_id, r.thread_id, r.item_id, r.media_id, now, now).changes;
    return changes ? this.run(id) : undefined;
  }

  run(id: string): Run | undefined {
    const r = this.db.prepare("SELECT * FROM flow_runs WHERE id = ?").get(id) as (Omit<Run, "vars"> & { vars: string }) | undefined;
    return r && toRun(r);
  }

  saveRun(r: Run, now: number): void {
    r.updated_at = now;
    this.db
      .prepare("UPDATE flow_runs SET thread_id = ?, step = ?, state = ?, vars = ?, updated_at = ? WHERE id = ?")
      .run(r.thread_id, r.step, r.state, JSON.stringify(r.vars), now, r.id);
  }

  /** Runs of a contact waiting for a tap or an email, newest first. */
  waitingRuns(net: string, contact: string, since: number): Run[] {
    return (
      this.db
        .prepare("SELECT * FROM flow_runs WHERE net = ? AND contact_id = ? AND state = 'waiting_input' AND updated_at > ? ORDER BY updated_at DESC, rowid DESC")
        .all(net, contact, since) as (Omit<Run, "vars"> & { vars: string })[]
    ).map(toRun);
  }

  /** Stops every open run of a contact (opt-out) or of a flow (flow edited). Returns the stopped runs. */
  stopRuns(where: { net: string; contact: string } | { flow: string }, now: number): Run[] {
    const [sql, args]: [string, string[]] =
      "flow" in where ? ["flow_id = ?", [where.flow]] : ["net = ? AND contact_id = ?", [where.net, where.contact]];
    const rows = (
      this.db.prepare(`SELECT * FROM flow_runs WHERE ${sql} AND state IN ('active','waiting_input')`).all(...args) as (Omit<Run, "vars"> & { vars: string })[]
    ).map(toRun);
    this.db.prepare(`UPDATE flow_runs SET state = 'stopped', updated_at = ? WHERE ${sql} AND state IN ('active','waiting_input')`).run(now, ...args);
    return rows;
  }

  // ---- events / ledger / opt-outs ------------------------------------------

  event(e: { flow?: string | null; run?: string | null; type: EventType; reason?: string; step?: number; media?: string | null }, now: number): void {
    this.db
      .prepare("INSERT INTO flow_events (flow_id, run_id, type, reason, step, media_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.flow ?? null, e.run ?? null, e.type, e.reason ?? null, e.step ?? null, e.media ?? null, now);
  }

  /** Records an item as evaluated. False if it was evaluated before (webhook + poll duplicates, retries). */
  markSeen(itemId: string, now: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO flow_seen (item_id, ts) VALUES (?, ?)").run(itemId, now).changes > 0;
  }

  optedOut(net: string, contact: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM contacts_optout WHERE net = ? AND contact_id = ?").get(net, contact);
  }

  optOut(net: string, contact: string, keyword: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO contacts_optout (net, contact_id, keyword, ts) VALUES (?, ?, ?, ?)").run(net, contact, keyword, now);
  }

  /** Same flow step already messaged this contact since `since` (per-contact cooldown). */
  recentlyDrafted(flow: string, step: number, net: string, contact: string, since: number): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM flow_events e JOIN flow_runs r ON r.id = e.run_id
         WHERE e.type = 'drafted' AND e.flow_id = ? AND e.step = ? AND r.net = ? AND r.contact_id = ? AND e.ts > ? LIMIT 1`,
      )
      .get(flow, step, net, contact, since);
  }

  /** Automated drafts created since `since`, across all flows (hourly cap). */
  draftedSince(since: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM flow_events WHERE type = 'drafted' AND ts > ?").get(since) as { n: number }).n;
  }
}
