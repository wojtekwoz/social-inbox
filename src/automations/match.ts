// Deterministic text matching for triggers, opt-outs and email capture. No AI involved.

// Letters NFD does not decompose (Polish ł, Nordic ø, …).
const FOLD: Record<string, string> = { ł: "l", đ: "d", ø: "o", æ: "ae", œ: "oe", ß: "ss", ı: "i", þ: "th" };

/** Lowercase, strip diacritics, turn punctuation/emoji into spaces, collapse whitespace. */
export function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[łđøæœßıþ]/g, (c) => FOLD[c]!)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type MatchMode = "exact" | "word" | "contains";

/** Returns the first keyword that matches, or undefined. `word` (default) = whole word or phrase. */
export function matchKeyword(text: string | null | undefined, keywords: string[], mode: MatchMode = "word"): string | undefined {
  const t = normalize(text);
  if (!t) return undefined;
  for (const k of keywords) {
    const n = normalize(k);
    if (!n) continue;
    if (mode === "exact" ? t === n : mode === "contains" ? t.includes(n) : ` ${t} `.includes(` ${n} `)) return k;
  }
  return undefined;
}

export const OPT_OUT_KEYWORDS = ["stop", "stopp", "nie pisz", "unsubscribe"];

/**
 * Opt-out only when the whole message is the keyword ("STOP", "nie pisz!"), so that
 * "can't stop watching your reels" does not unsubscribe anyone.
 */
export function optOutKeyword(text: string | null | undefined): string | undefined {
  const t = normalize(text);
  return OPT_OUT_KEYWORDS.find((k) => k === t);
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;

export function isEmail(s: string): boolean {
  if (s.length > 254 || !EMAIL.test(s)) return false;
  const local = s.slice(0, s.lastIndexOf("@"));
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
}

/** Finds exactly one email address in a message ("to mój mail: ania@example.pl"); lowercased. */
export function extractEmail(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const found = new Set(
    text
      .split(/[\s,;]+/)
      .map((w) => w.replace(/^[<(["'“„]+|[>)\]"'”.!?:]+$/g, ""))
      .filter((w) => w.includes("@") && isEmail(w))
      .map((w) => w.toLowerCase()),
  );
  return found.size === 1 ? [...found][0] : undefined;
}
