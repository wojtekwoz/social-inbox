import type { Connector, IncomingItem, SendRequest, SendResult, Src } from "../../core/types.js";
import { D, H } from "../../core/time.js";

// Deterministic fake connector for tests and demos (FAKE_CONNECTOR=true).
// It mimics Instagram's rules so drafts and windows behave realistically.

const PEOPLE = ["@ania_k", "@marek.p", "@kasia_codes", "@tomek", "@julia.design", "@piotr_dev", "@ola.photo", "@bartek"];
const TEXTS: [Src, string][] = [
  ["ig.dm", "Hej! Ile kosztuje minikurs i czy jest dla początkujących?"],
  ["ig.cm", "Super odcinek, a jak zrobiłeś ten efekt przejścia na końcu?"],
  ["ig.dm", "Hi, are you open to a paid collab next month? We're a small design studio."],
  ["ig.cm", "🔥🔥🔥"],
  ["ig.cm", "Check my profile for crypto giveaway winner promo code"],
  ["ig.dm", "Kupiłam kurs ale link do lekcji 3 nie działa, możesz sprawdzić?"],
  ["ig.cm", "Dzięki za ten materiał, bardzo pomocny"],
  ["ig.mn", "@wozu_co zobacz to, chyba coś dla ciebie"],
  ["ig.cm", "Czy będzie druga część?"],
  ["ig.dm", "Thanks for the quick reply yesterday!"],
];

export class FakeConnector implements Connector {
  net = "fake";
  limits = { dmWindowMs: 24 * H, humanAgentWindowMs: 7 * D, privateReplyWindowMs: 7 * D, dmMax: 1000, replyMax: 2200 };
  moderation = ["hide", "unhide", "delete"] as const;
  private queue: IncomingItem[] = [];
  private n = 0;
  sent: SendRequest[] = [];
  /** Make the next N sends throw (for retry tests). */
  failNext: Error[] = [];

  constructor(private now: () => number = Date.now) {}

  /** Queue `count` deterministic items, spread over the last `spanMs`. */
  generate(count: number, spanMs = 2 * H): IncomingItem[] {
    const out: IncomingItem[] = [];
    for (let k = 0; k < count; k++) {
      const i = this.n++;
      const [src, text] = TEXTS[i % TEXTS.length]!;
      const who = PEOPLE[i % PEOPLE.length]!;
      const uid = `u${i % PEOPLE.length}`;
      const ts = this.now() - Math.floor(spanMs * (1 - k / Math.max(1, count)));
      const post = src === "ig.dm" ? undefined : { nativeId: `m${i % 3}`, permalink: `https://instagram.com/p/fake${i % 3}` };
      out.push({
        net: this.net,
        nativeId: `n${i}`,
        src,
        threadNativeId: src === "ig.dm" ? `dm:${uid}` : `n${i}`,
        authorId: uid,
        who,
        text,
        ts,
        post,
        raw: { id: `n${i}`, text },
      });
    }
    this.queue.push(...out);
    return out;
  }

  push(...items: IncomingItem[]): void {
    this.queue.push(...items);
  }

  async poll(scope?: string): Promise<IncomingItem[]> {
    const take = this.queue.filter((it) => !scope || it.src.endsWith(`.${scope}`));
    this.queue = this.queue.filter((it) => !take.includes(it));
    return take;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const err = this.failNext.shift();
    if (err) throw err;
    this.sent.push(req);
    return { nativeId: `out${this.sent.length}`, raw: { ok: true } };
  }
}
