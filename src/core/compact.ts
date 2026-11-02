// Compact, columnar responses. Token budget is enforced here, not by the caller.

export const LIMITS = {
  limitDefault: 20,
  limitMax: 50,
  maxCharsDefault: 200,
  maxCharsMax: 2000,
  threadLastDefault: 8,
  threadLastMax: 30,
  /** Overall response cap (~4k tokens). */
  responseTokens: 4000,
};

export const clamp = (v: number | undefined, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.floor(v ?? d)));

export function trunc(s: string | null | undefined, n: number): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  return flat.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/**
 * Rough token estimate. JSON with short keys and mixed-language text averages ~3.2
 * chars/token on current tokenizers; we use 3 to stay conservative.
 */
export function estimateTokens(v: unknown): number {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return Math.ceil(s.length / 3);
}

export type Row = Record<string, unknown>;

export interface Table {
  cols: string[];
  rows: unknown[][];
}

/** Columns that are dropped when every row has no value for them. */
const OPTIONAL = new Set(["lbl", "win", "on", "me", "t", "url", "nid", "raw", "read", "ts", "auto"]);

const empty = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);

export function columnar(objs: Row[], cols: string[]): Table {
  const keep = cols.filter((c) => !OPTIONAL.has(c) || objs.some((o) => !empty(o[c])));
  return { cols: keep, rows: objs.map((o) => keep.map((c) => (empty(o[c]) ? null : o[c]))) };
}

/** One TSV line per row with a header line. Lists are joined with ",". */
export function lines(t: Table): string {
  const cell = (v: unknown) =>
    v === null || v === undefined ? "" : Array.isArray(v) ? v.join(",") : String(v).replace(/[\t\n]/g, " ");
  return [t.cols.join("\t"), ...t.rows.map((r) => r.map(cell).join("\t"))].join("\n");
}

/** Drop rows from the end until the payload fits the token cap. Returns the number of rows kept. */
export function fitRows<T>(rows: T[], render: (rows: T[]) => unknown, cap = LIMITS.responseTokens): number {
  let n = rows.length;
  while (n > 0 && estimateTokens(render(rows.slice(0, n))) > cap) n--;
  return n;
}
