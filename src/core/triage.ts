import type { Label } from "./types.js";

// Cheap rule-based triage (EN + PL). No LLM calls inside the server; agents refine via `mark`.
// `\b` is ASCII-only in JS, so words are wrapped in Unicode-aware boundaries.
const words = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "iu");

const RULES: [Label, RegExp[]][] = [
  [
    "q",
    [
      /\?/,
      words("how|what|when|where|why|which|jak|ile|czy|gdzie|kiedy|dlaczego|który|która|jakie"),
    ],
  ],
  [
    "lead",
    [
      words(
        "price|pricing|cost|buy|purchase|course|collab|collaboration|sponsor\\w*|offer|quote|hire|cena|ceny|cenę|koszt\\w*|kupi\\w*|kurs\\w*|minikurs\\w*|współprac\\w*|oferta|ofert\\w*|zlecenie|wycen\\w*",
      ),
    ],
  ],
  [
    "praise",
    [
      /🔥|❤️|❤|😍|👏|🙌/u,
      words("love|great|awesome|amazing|thanks|thank you|super|świetn\\w*|dzięki|dziękuję|genialn\\w*|ekstra|mega"),
    ],
  ],
  [
    "spam",
    [
      words(
        "follow\\s*(?:for|4)\\s*follow|f4f|dm (?:me|us) (?:for|to)|check my (?:page|profile|bio)|crypto|bitcoin|forex|investment opportunity|promo code|giveaway winner|onlyfans",
      ),
      /https?:\/\/\S+[\s\S]*https?:\/\/\S+/i,
    ],
  ],
  [
    "complaint",
    [
      words(
        "doesn'?t work|not working|broken|refund|scam|disappointed|terrible|awful|problem|nie działa|zwrot\\w*|oszust\\w*|reklamacj\\w*|rozczarowan\\w*|beznadziejn\\w*",
      ),
    ],
  ],
];

export function triage(text: string | null | undefined, me = false): Label[] {
  if (!text || me) return [];
  const out: Label[] = [];
  for (const [label, res] of RULES) if (res.some((re) => re.test(text))) out.push(label);
  if (out.includes("spam")) return ["spam"];
  if (out.includes("lead") || out.includes("complaint")) out.push("needs-wozu");
  return out;
}
