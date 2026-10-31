import { UserError } from "../core/errors.js";
import type { ItemWithThread } from "../core/store.js";
import type { Service } from "../core/service.js";
import { D, H } from "../core/time.js";
import type { DraftKind, DraftPayload, DraftRow, Label, ThreadRow } from "../core/types.js";
import { replyWindow } from "../core/window.js";
import type { EmailProviders } from "./email.js";
import { extractEmail, optOutKeyword } from "./match.js";
import { armedPayloads, WINDOW_STEPS, type Step } from "./schema.js";
import { FlowStore, type Flow, type Run } from "./store.js";
import { classify, matchTrigger, type Inbound } from "./triggers.js";

// The rules engine. Every newly ingested inbound item is evaluated exactly once; matching
// flows run their steps, and every message becomes a normal draft in the existing
// drafts → approval → audit pipeline. No LLM calls.

export const AUTOMATION_ACTOR = "system:automation";
/** Items older than the moment a flow was switched on (minus poll lag) never trigger it. */
const GRACE_MS = 15 * 60_000;
const TAP_WAIT_MS = 7 * D;
const EMAIL_WAIT_MS = 24 * H;

type Outcome = "next" | "wait" | "stop" | "end";
type StepOf<S extends Step["type"]> = Extract<Step, { type: S }>;

export class Automations {
  readonly flows: FlowStore;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private svc: Service,
    readonly email: EmailProviders = {},
  ) {
    this.flows = new FlowStore(svc.db);
  }

  get enabled(): boolean {
    return this.svc.config.automations.enabled;
  }

  /** Evaluates new item ids in order. Calls are serialised so webhook and poll ingests never interleave runs. */
  evaluate(ids: string[]): Promise<void> {
    if (!this.enabled || !ids.length) return Promise.resolve();
    const job = this.chain.then(async () => {
      for (const id of ids) await this.evalOne(id);
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  private async evalOne(id: string): Promise<void> {
    if (!this.flows.markSeen(id, this.svc.now())) return;
    const item = this.svc.store.item(id);
    if (!item || item.me || item.deleted) return;
    const post = item.post_id ? this.svc.store.post(item.post_id) : undefined;
    const inbound = classify(item, post);
    if (!inbound) return;
    const contact = item.author_id ?? (inbound.kind === "comment" ? `cm:${item.native_id}` : undefined);
    if (!contact) return;
    try {
      if (inbound.kind === "dm" || inbound.kind === "story_reply") {
        const kw = optOutKeyword(inbound.text);
        if (kw) return this.optOut(item, contact, kw);
      }
      if (inbound.kind !== "comment" && (await this.resume(item, inbound, contact))) return;
      for (const f of this.flows.flows(true)) {
        if (matchTrigger(f.trigger, inbound)) return await this.start(f, item, inbound, contact);
      }
      // Unmatched: the item stays in the inbox untouched.
    } catch (e) {
      this.svc.log.error({ item: id, err: (e as Error).message }, "automation failed");
    }
  }

  // ---- runs -------------------------------------------------------------------

  private optOut(item: ItemWithThread, contact: string, kw: string) {
    const now = this.svc.now();
    this.flows.optOut(item.net, contact, kw, now);
    for (const r of this.flows.stopRuns({ net: item.net, contact }, now))
      this.flows.event({ flow: r.flow_id, run: r.id, type: "skipped", reason: "opted_out", media: r.media_id }, now);
    this.svc.store.audit(AUTOMATION_ACTOR, "opt_out", item.thread_id, { kw }, now);
  }

  private async start(flow: Flow, item: ItemWithThread, inbound: Inbound, contact: string) {
    const now = this.svc.now();
    const media = inbound.kind === "comment" ? inbound.media : "story" in inbound ? inbound.story : undefined;
    const skip = (reason: string) => this.flows.event({ flow: flow.id, type: "skipped", reason, media }, now);
    if (this.flows.optedOut(item.net, contact)) return skip("opted_out");
    const prWindow = this.svc.connector(item.net)?.limits.privateReplyWindowMs ?? 7 * D;
    if (inbound.kind === "comment" && flow.steps.some((s) => s.type === "private_reply") && item.ts + prWindow <= now)
      return skip("comment_too_old");
    if (item.ts < (flow.enabledAt ?? flow.createdAt) - GRACE_MS) return skip("before_flow");

    const run = this.flows.createRun(
      { flow_id: flow.id, net: item.net, contact_id: contact, thread_id: item.thread_id, item_id: item.id, media_id: media ?? null },
      now,
    );
    if (!run) return;
    this.flows.event({ flow: flow.id, run: run.id, type: "triggered", media }, now);
    this.label(item.id, "auto");
    await this.advance(flow, run);
  }

  /** A tap or an email reply continues a waiting run. True if the item was consumed. */
  private async resume(item: ItemWithThread, inbound: Inbound, contact: string): Promise<boolean> {
    const now = this.svc.now();
    for (const run of this.flows.waitingRuns(item.net, contact, now - TAP_WAIT_MS)) {
      const flow = this.flows.flow(run.flow_id);
      if (!flow?.enabled) continue;
      if (inbound.kind === "postback" && run.vars.tap?.includes(inbound.payload.trim())) {
        this.flows.event({ flow: flow.id, run: run.id, type: inbound.via === "button" ? "button_tap" : "quick_reply", media: run.media_id }, now);
        delete run.vars.tap;
        run.thread_id = item.thread_id;
        run.state = "active";
        this.label(item.id, "auto");
        await this.advance(flow, run);
        return true;
      }
      const ask = run.vars.ask;
      if (ask && inbound.kind === "dm" && now - run.updated_at < EMAIL_WAIT_MS) {
        run.thread_id = item.thread_id;
        const email = extractEmail(inbound.text);
        if (email) {
          run.vars.email = email;
          delete run.vars.ask;
          run.state = "active";
          this.flows.event({ flow: flow.id, run: run.id, type: "email_captured", step: ask.step, media: run.media_id }, now);
          this.label(item.id, "auto");
          await this.advance(flow, run);
          return true;
        }
        const s = flow.steps[ask.step];
        if (ask.tries === 0 && s?.type === "ask_email") {
          ask.tries = 1;
          const r = await this.message(flow, run, ask.step, "dm", s.retry_text ?? s.text, undefined, { retry: true });
          if (r !== "ok") run.state = "stopped";
        } else {
          run.state = "stopped";
          this.flows.event({ flow: flow.id, run: run.id, type: "skipped", reason: "invalid_email", step: ask.step, media: run.media_id }, now);
        }
        this.flows.saveRun(run, now);
        return true;
      }
    }
    return false;
  }

  private async advance(flow: Flow, run: Run): Promise<void> {
    while (run.step < flow.steps.length) {
      const i = run.step;
      const s = flow.steps[i]!;
      // An armed button/quick reply means the person has to tap before we may DM them.
      if (run.vars.tap && WINDOW_STEPS.has(s.type)) {
        run.state = "waiting_input";
        break;
      }
      let out: Outcome;
      try {
        out = await this.exec(flow, run, s, i);
      } catch (e) {
        this.flows.event({ flow: flow.id, run: run.id, type: "failed", reason: (e as Error).message.slice(0, 200), step: i, media: run.media_id }, this.svc.now());
        run.state = "failed";
        break;
      }
      if (out === "stop") {
        run.state = "stopped";
        break;
      }
      run.step = i + 1;
      if (out === "wait") {
        run.state = "waiting_input";
        break;
      }
      if (out === "end") {
        run.state = "done";
        break;
      }
    }
    if (run.state === "active" && run.step >= flow.steps.length) run.state = "done";
    this.flows.saveRun(run, this.svc.now());
  }

  private async exec(flow: Flow, run: Run, s: Step, i: number): Promise<Outcome> {
    const arm = () => {
      const p = armedPayloads(s);
      if (p.length) run.vars.tap = p;
    };
    switch (s.type) {
      case "private_reply": {
        const r = await this.message(flow, run, i, "private_reply", s.text, s.button ? { buttons: [s.button] } : undefined);
        if (r !== "ok") return "stop";
        arm();
        return "next";
      }
      case "public_reply": {
        const n = this.flows.nextRr(flow.id);
        await this.message(flow, run, i, "reply", s.variants[n % s.variants.length]!);
        return "next"; // a skipped public reply never blocks the private flow
      }
      case "send_dm": {
        const payload = s.buttons ? { buttons: s.buttons } : s.quick_replies ? { quick_replies: s.quick_replies } : undefined;
        if ((await this.message(flow, run, i, "dm", s.text, payload)) !== "ok") return "stop";
        arm();
        return "next";
      }
      case "ask_email": {
        if ((await this.message(flow, run, i, "dm", s.text)) !== "ok") return "stop";
        run.vars.ask = { step: i, tries: 0 };
        return "wait";
      }
      case "push_email":
        await this.pushEmail(flow, run, s, i);
        return "next";
      case "tag":
        if (run.thread_id) this.svc.store.mark({ ids: [run.thread_id], add: [s.label as Label] });
        return "next";
      case "soft_follow_ask":
        // Only when we positively know they don't follow. Never blocks delivery.
        if (run.vars.follows === false) await this.message(flow, run, i, "dm", s.text);
        return "next";
      case "handoff":
        if (run.thread_id) this.svc.store.mark({ ids: [run.thread_id], add: ["needs-wozu"], read: false });
        this.svc.store.audit(AUTOMATION_ACTOR, "handoff", run.thread_id ?? undefined, { flow: flow.id, run: run.id, note: s.note }, this.svc.now());
        return "end";
    }
  }

  // ---- steps → drafts ---------------------------------------------------------

  private skip(flow: Flow, run: Run, step: number, reason: string): "skipped" {
    this.flows.event({ flow: flow.id, run: run.id, type: "skipped", reason, step, media: run.media_id }, this.svc.now());
    return "skipped";
  }

  private dmThread(run: Run): ThreadRow | undefined {
    const t = run.thread_id ? this.svc.store.thread(run.thread_id) : undefined;
    if (t?.src === "ig.dm") return t;
    return this.svc.db.prepare("SELECT * FROM threads WHERE net = ? AND native_id = ?").get(run.net, `dm:${run.contact_id}`) as ThreadRow | undefined;
  }

  /** Send policy, then a draft. Returns "ok" when a draft exists for this step. */
  private async message(
    flow: Flow,
    run: Run,
    step: number,
    kind: Extract<DraftKind, "dm" | "reply" | "private_reply">,
    text: string,
    payload?: Omit<DraftPayload, "flow" | "step">,
    opts: { retry?: boolean } = {},
  ): Promise<"ok" | "skipped"> {
    const now = this.svc.now();
    const cfg = this.svc.config;
    const c = this.svc.connector(run.net);
    if (!c) return this.skip(flow, run, step, "no_connector");
    if (this.flows.optedOut(run.net, run.contact_id)) return this.skip(flow, run, step, "opted_out");
    if (!opts.retry && this.flows.recentlyDrafted(flow.id, step, run.net, run.contact_id, now - cfg.automations.cooldownHours * H))
      return this.skip(flow, run, step, "cooldown");
    if (this.flows.draftedSince(now - H) >= cfg.maxSendsPerHour) return this.skip(flow, run, step, "limit");

    let to = run.item_id;
    if (kind === "dm") {
      const t = this.dmThread(run);
      // Standard 24 h window only: automations never use the HUMAN_AGENT tag.
      if (!t || !replyWindow(t.last_in_ts, { windowMs: c.limits.dmWindowMs }, now).open) return this.skip(flow, run, step, "window_closed");
      to = t.id;
      run.thread_id = t.id;
    } else if (kind === "private_reply") {
      const item = this.svc.store.item(to);
      if (!item || item.ts + (c.limits.privateReplyWindowMs ?? 0) <= now) return this.skip(flow, run, step, "comment_too_old");
      const dup = this.svc.db
        .prepare("SELECT 1 FROM drafts WHERE kind = 'private_reply' AND item_id = ? AND status IN ('pending','approved','sending','sent')")
        .get(to);
      if (dup) return this.skip(flow, run, step, "duplicate");
    }

    let d: string;
    try {
      const r = this.svc.createDraft(
        { to, text, kind, key: `auto:${run.id}:${step}${opts.retry ? ":retry" : ""}`, payload: { ...payload, flow: flow.id, step }, flowRunId: run.id },
        AUTOMATION_ACTOR,
      );
      if (r.dup) return "ok";
      d = r.d;
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      const m = e.message;
      return this.skip(flow, run, step, /window closed/.test(m) ? "window_closed" : /only one private reply/.test(m) ? "duplicate" : /too long/.test(m) ? "too_long" : "invalid");
    }
    this.flows.event({ flow: flow.id, run: run.id, type: "drafted", step, media: run.media_id }, now);
    if (flow.mode === "auto" && cfg.automations.autosend) await this.autoSend(flow, run, step, d);
    return "ok";
  }

  /** mode:auto + AUTOMATIONS_AUTOSEND: approve as system:automation; execute only when SENDING_ENABLED. */
  private async autoSend(flow: Flow, run: Run, step: number, d: string) {
    try {
      this.svc.approve(d, AUTOMATION_ACTOR);
      if (!this.svc.config.sendingEnabled) return; // stays approved, like any human-approved draft
      const r = await this.svc.sendApproved(d, AUTOMATION_ACTOR);
      if (r.st === "failed") this.flows.event({ flow: flow.id, run: run.id, type: "failed", reason: String(r.err).slice(0, 200), step, media: run.media_id }, this.svc.now());
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      if (e.status === 429) this.skip(flow, run, step, "limit");
      else this.flows.event({ flow: flow.id, run: run.id, type: "failed", reason: e.message.slice(0, 200), step, media: run.media_id }, this.svc.now());
    }
  }

  private async pushEmail(flow: Flow, run: Run, s: StepOf<"push_email">, step: number) {
    const p = this.email[s.provider];
    if (!p) return this.skip(flow, run, step, "email_off");
    if (!run.vars.email) return this.skip(flow, run, step, "no_email");
    // Pushing to a list is an external write: same kill switch as platform sends.
    if (!this.svc.config.sendingEnabled) return this.skip(flow, run, step, "sending_off");
    try {
      await p.push({
        email: run.vars.email,
        tags: s.tags ?? [],
        group: s.group,
        event: s.event,
        source: { channel: "instagram", flow: flow.id, run: run.id, media: run.media_id ?? undefined },
      });
      const now = this.svc.now();
      this.flows.event({ flow: flow.id, run: run.id, type: "email_pushed", step, media: run.media_id }, now);
      this.svc.store.audit(AUTOMATION_ACTOR, "email_push", run.id, { provider: p.name }, now);
    } catch (e) {
      this.flows.event({ flow: flow.id, run: run.id, type: "failed", reason: `${p.name}: ${(e as Error).message}`.slice(0, 200), step, media: run.media_id }, this.svc.now());
    }
  }

  private label(id: string, l: Label) {
    this.svc.store.mark({ ids: [id], add: [l] });
  }

  // ---- hooks used by Service ------------------------------------------------------

  /** Called inside the send transaction for drafts created by a flow. */
  onSent(d: DraftRow, now: number): void {
    if (!d.flow_run_id) return;
    const run = this.flows.run(d.flow_run_id);
    if (!run) return;
    const p = d.payload ? (JSON.parse(d.payload) as DraftPayload) : {};
    this.flows.event({ flow: run.flow_id, run: run.id, type: d.kind === "reply" ? "public_reply" : "sent", step: p.step, media: run.media_id }, now);
  }

  /** `auto` block for inbox_overview: last 24 h, plus automation drafts awaiting approval. */
  overview(): Record<string, number> | "off" | undefined {
    if (!this.enabled) {
      const n = (this.svc.db.prepare("SELECT count(*) AS n FROM flows WHERE enabled = 1").get() as { n: number }).n;
      return n ? "off" : undefined;
    }
    const since = this.svc.now() - 24 * H;
    const ev = Object.fromEntries(
      (
        this.svc.db
          .prepare("SELECT type, count(*) AS n FROM flow_events WHERE ts > ? AND type IN ('triggered','sent','public_reply') GROUP BY type")
          .all(since) as { type: string; n: number }[]
      ).map((r) => [r.type, r.n]),
    );
    const pending = (this.svc.db.prepare("SELECT count(*) AS n FROM drafts WHERE flow_run_id IS NOT NULL AND status = 'pending'").get() as { n: number }).n;
    return { triggered: ev.triggered ?? 0, sent: (ev.sent ?? 0) + (ev.public_reply ?? 0), pending };
  }
}
