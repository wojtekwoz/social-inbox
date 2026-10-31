import { z } from "zod";
import { columnar, type Row } from "../core/compact.js";
import { UserError } from "../core/errors.js";
import type { In } from "../core/schemas.js";
import type { Service } from "../core/service.js";
import type { Automations } from "./engine.js";
import { normalize, optOutKeyword } from "./match.js";
import { flowMetrics, weekCounts } from "./metrics.js";
import { triggerSummary, validateFlow } from "./schema.js";
import type { Flow } from "./store.js";
import { matchTrigger, triggerKind, type Inbound } from "./triggers.js";

// Agent-facing flow operations shared by MCP, REST and the CLI.
// Trigger/steps are loose objects here (cheap tool schemas); validateFlow does the real check.

const id = z.string().regex(/^f[0-9a-z]+$/).describe('Flow id, e.g. "f1"');

export const flowGetShape = { id };
export const flowUpsertShape = {
  id: id.optional().describe("Omit to create"),
  name: z.string(),
  enabled: z.boolean().optional().describe("Default false"),
  mode: z.enum(["draft", "auto"]).optional().describe("draft (default) = drafts await human approval"),
  priority: z.number().int().optional().describe("Lower runs first, default 100"),
  trigger: z.record(z.string(), z.unknown()).describe("{type: comment_keyword|dm_keyword|story_reply|story_mention|postback|ice_breaker, keywords?, match?, media_ids?, payload?}"),
  steps: z
    .array(z.record(z.string(), z.unknown()))
    .describe("[{type: private_reply|public_reply|send_dm|ask_email|push_email|tag|soft_follow_ask|handoff, …}]"),
};
export const flowToggleShape = { id, on: z.boolean() };
export const flowMetricsShape = { id: id.optional(), days: z.number().int().optional().describe("Default 7, max 90") };
export const flowTestShape = {
  id,
  text: z.string().describe("Comment/DM text, or the postback payload for postback flows"),
  media: z.string().optional().describe("Post short id or native media id (comment flows)"),
};

const iso = (ts: number | null) => (ts ? new Date(ts).toISOString() : null);

export class FlowApi {
  constructor(
    private svc: Service,
    private auto: Automations,
  ) {}

  private get(id: string): Flow {
    const f = this.auto.flows.flow(id);
    if (!f) throw new UserError(`unknown flow ${id}`, 404);
    return f;
  }

  list(): Row {
    const wk = weekCounts(this.svc.db, this.svc.now());
    const objs = this.auto.flows.flows().map((f) => ({
      f: f.id,
      name: f.name,
      on: f.enabled ? 1 : 0,
      mode: f.mode,
      trig: triggerSummary(f.trigger),
      n7: wk.get(f.id)?.trig ?? 0,
      s7: wk.get(f.id)?.sent ?? 0,
    }));
    const out: Row = { ...columnar(objs, ["f", "name", "on", "mode", "trig", "n7", "s7"]) };
    if (!this.auto.enabled) out.engine = "off";
    return out;
  }

  flowGet(p: In<typeof flowGetShape>): Row {
    const f = this.get(p.id);
    return {
      f: f.id,
      name: f.name,
      on: f.enabled ? 1 : 0,
      mode: f.mode,
      priority: f.priority,
      trigger: f.trigger,
      steps: f.steps,
      created: iso(f.createdAt),
      updated: iso(f.updatedAt),
    };
  }

  /**
   * Create or update. `canApprove`: only approve-scoped callers may create, edit or switch on
   * `mode: "auto"` flows, because those approve their own drafts when AUTOMATIONS_AUTOSEND=true.
   */
  upsert(p: unknown, actor: string, canApprove: boolean): Row {
    const f = validateFlow(p);
    const now = this.svc.now();
    const prev = f.id ? this.get(f.id) : undefined;
    if (!canApprove && (f.mode ?? prev?.mode ?? "draft") === "auto")
      throw new UserError('mode "auto" flows need an approve-scoped key (they approve their own drafts)', 403);
    let fid: string;
    if (prev) {
      // Runs mid-way through the old steps would resume at the wrong index.
      if (JSON.stringify(prev.steps) !== JSON.stringify(f.steps))
        for (const r of this.auto.flows.stopRuns({ flow: prev.id }, now))
          this.auto.flows.event({ flow: prev.id, run: r.id, type: "skipped", reason: "flow_changed", media: r.media_id }, now);
      this.auto.flows.update(prev, f, now);
      fid = prev.id;
    } else fid = this.auto.flows.insert(f, now);
    this.svc.store.audit(actor, prev ? "flow_update" : "flow_create", fid, { mode: f.mode ?? prev?.mode ?? "draft" }, now);
    const saved = this.get(fid);
    const out: Row = { f: fid, ok: true, on: saved.enabled ? 1 : 0, mode: saved.mode };
    if (!prev) out.created = true;
    if (!this.auto.enabled) out.engine = "off (AUTOMATIONS_ENABLED=false)";
    return out;
  }

  toggle(p: In<typeof flowToggleShape>, actor: string, canApprove: boolean): Row {
    const f = this.get(p.id);
    if (p.on && f.mode === "auto" && !canApprove) throw new UserError('switching on a mode "auto" flow needs an approve-scoped key', 403);
    this.auto.flows.setEnabled(f.id, p.on, this.svc.now());
    this.svc.store.audit(actor, p.on ? "flow_on" : "flow_off", f.id);
    return { f: f.id, on: p.on ? 1 : 0 };
  }

  metrics(p: In<typeof flowMetricsShape>): Row {
    if (p.id) this.get(p.id);
    return flowMetrics(this.svc.db, this.svc.now(), p);
  }

  /** Dry run: matcher + what would happen. No drafts, runs, events or ledger rows. */
  test(p: In<typeof flowTestShape>): Row {
    const f = this.get(p.id);
    const kind = triggerKind(f.trigger);
    const inbound: Inbound =
      kind === "postback"
        ? { kind, text: p.text, payload: p.text, via: "button" }
        : kind === "comment"
          ? { kind, text: p.text, media: p.media, postId: p.media }
          : { kind, text: p.text };
    const m = matchTrigger(f.trigger, inbound, p.media !== undefined);
    const cfg = this.svc.config;
    const out: Row = { f: f.id, m: m ? 1 : 0, norm: normalize(p.text) };
    if (m?.kw) out.kw = m.kw;
    if (kind !== "comment" && kind !== "postback" && optOutKeyword(p.text)) out.optout = 1;
    if (m) {
      out.steps = f.steps.map((s) => s.type);
      out.would = f.mode === "auto" && cfg.automations.autosend ? (cfg.sendingEnabled ? "send" : "approve") : "draft";
    }
    const off = [!cfg.automations.enabled && "engine off", !f.enabled && "flow off"].filter(Boolean);
    if (off.length) out.off = off.join(", ");
    if (kind === "comment" && p.media === undefined && f.trigger.type === "comment_keyword" && Array.isArray(f.trigger.media_ids)) out.media = "not checked";
    return out;
  }
}
