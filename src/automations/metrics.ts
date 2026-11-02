import { columnar, type Row } from "../core/compact.js";
import type { DB } from "../core/db.js";
import { D } from "../core/time.js";

// flow_events → compact counts per flow (and per trigger media for a single flow).

const COLS: [string, string][] = [
  ["trig", "triggered"],
  ["draft", "drafted"],
  ["sent", "sent"],
  ["pub", "public_reply"],
  ["tap", "button_tap"],
  ["qr", "quick_reply"],
  ["email", "email_captured"],
  ["push", "email_pushed"],
  ["skip", "skipped"],
  ["fail", "failed"],
];

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 100) / 100 : null);

export function flowMetrics(db: DB, now: number, p: { id?: string; days?: number }): Row {
  const days = Math.min(90, Math.max(1, Math.floor(p.days ?? 7)));
  const since = now - days * D;
  const where = p.id ? "AND e.flow_id = ?" : "";
  const args: unknown[] = p.id ? [since, p.id] : [since];

  const counts = db
    .prepare(`SELECT e.flow_id AS f, e.type, count(*) AS n FROM flow_events e WHERE e.ts > ? AND e.flow_id IS NOT NULL ${where} GROUP BY e.flow_id, e.type`)
    .all(...args) as { f: string; type: string; n: number }[];
  const names = new Map((db.prepare("SELECT id, name FROM flows").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  const by = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const o = by.get(c.f) ?? {};
    o[c.type] = c.n;
    by.set(c.f, o);
  }
  if (p.id && !by.size) by.set(p.id, {});
  const objs = [...by.entries()].map(([f, o]) => ({ f, name: names.get(f) ?? "?", ...Object.fromEntries(COLS.map(([k, t]) => [k, o[t] ?? 0])) }));
  const out: Row = { days, ...columnar(objs, ["f", "name", ...COLS.map(([k]) => k)]) };

  const why = db
    .prepare(`SELECT e.reason, count(*) AS n FROM flow_events e WHERE e.ts > ? AND e.type = 'skipped' ${where} GROUP BY e.reason ORDER BY n DESC`)
    .all(...args) as { reason: string | null; n: number }[];
  if (why.length) out.why = Object.fromEntries(why.map((r) => [r.reason ?? "?", r.n]));

  if (p.id) {
    const o = objs[0] as unknown as Record<string, number>;
    out.conv = {
      sent_per_trig: ratio(o.sent ?? 0, o.trig ?? 0),
      tap_per_sent: ratio((o.tap ?? 0) + (o.qr ?? 0), o.sent ?? 0),
      email_per_tap: ratio(o.email ?? 0, (o.tap ?? 0) + (o.qr ?? 0)),
      push_per_email: ratio(o.push ?? 0, o.email ?? 0),
    };
    const media = db
      .prepare(
        `SELECT e.media_id AS media, sum(e.type = 'triggered') AS trig, sum(e.type = 'sent') AS sent, sum(e.type = 'email_captured') AS email
         FROM flow_events e WHERE e.ts > ? ${where} AND e.media_id IS NOT NULL GROUP BY e.media_id ORDER BY trig DESC LIMIT 20`,
      )
      .all(...args) as Row[];
    if (media.length) out.media = columnar(media, ["media", "trig", "sent", "email"]);
  }
  return out;
}

/** Triggered / sent counts per flow over the last 7 days (for flow_list). */
export function weekCounts(db: DB, now: number): Map<string, { trig: number; sent: number }> {
  const rows = db
    .prepare(
      "SELECT flow_id AS f, sum(type = 'triggered') AS trig, sum(type IN ('sent','public_reply')) AS sent FROM flow_events WHERE ts > ? AND flow_id IS NOT NULL GROUP BY flow_id",
    )
    .all(now - 7 * D) as { f: string; trig: number; sent: number }[];
  return new Map(rows.map((r) => [r.f, { trig: r.trig, sent: r.sent }]));
}
