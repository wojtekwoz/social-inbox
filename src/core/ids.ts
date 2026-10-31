import type { DB } from "./db.js";
import { UserError } from "./errors.js";

// Short IDs: a one-letter type prefix + a base36 counter ("i7k", "t3f", "d12", "p9", "f2", "r5").
export type IdPrefix = "i" | "t" | "d" | "p" | "f" | "r";

export function nextCounter(db: DB, name: string): number {
  const row = db
    .prepare(
      "INSERT INTO counters (name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n",
    )
    .get(name) as { n: number };
  return row.n;
}

export function newId(db: DB, prefix: IdPrefix): string {
  return prefix + nextCounter(db, prefix).toString(36);
}

export function nextSeq(db: DB): number {
  return nextCounter(db, "seq");
}

export function headSeq(db: DB): number {
  const row = db.prepare("SELECT n FROM counters WHERE name = 'seq'").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

// Delta cursors: "c_" + base36 sequence number. Opaque to clients.
export function encodeCursor(seq: number): string {
  return "c_" + seq.toString(36);
}

export function decodeCursor(c: string | undefined | null): number | undefined {
  if (!c) return undefined;
  const m = /^c_([0-9a-z]+)$/.exec(c);
  if (!m) throw new UserError(`bad cursor "${c}"`);
  return parseInt(m[1]!, 36);
}
