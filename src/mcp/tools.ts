import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as F from "../automations/api.js";
import type { Principal, Scope } from "../core/auth.js";
import { UserError } from "../core/errors.js";
import * as S from "../core/schemas.js";
import type { Service } from "../core/service.js";

// MCP tools: thin wrappers over Service. Descriptions are deliberately terse because
// every connected agent pays for them in its context window.

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (v: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (msg: string): Result => ({ content: [{ type: "text", text: JSON.stringify({ err: msg }) }], isError: true });

export function createMcpServer(svc: Service, who: Principal, version = "0.1.0"): McpServer {
  const server = new McpServer(
    { name: "social-inbox", version },
    {
      instructions:
        "Agent-first social inbox (Instagram). Start with inbox_overview, then inbox_list with since=<cursor> for deltas. " +
        "Replies and moderation are drafts; a human approves them; then send_approved executes. Write thread_note summaries so later sessions reuse them.",
    },
  );

  const tool = <Sh extends S.Shape>(
    name: string,
    scope: Scope,
    description: string,
    shape: Sh,
    fn: (args: S.In<Sh>) => unknown | Promise<unknown>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {},
  ) => {
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: S.In<Sh>) => {
      if (!who.scopes.has(scope)) return fail(`key lacks scope "${scope}"`);
      try {
        return ok(await fn(args));
      } catch (e) {
        if (e instanceof UserError) return fail(e.message);
        svc.log.error({ tool: name, err: (e as Error).message }, "tool error");
        return fail("internal error");
      }
    }) as never);
  };

  const actor = `mcp:${who.name}`;
  const ro = { readOnlyHint: true };

  tool("inbox_overview", "read", "Unread counts per source, DM windows closing soon, head cursor. Call first.", {}, () => svc.overview(), ro);
  tool(
    "inbox_list",
    "read",
    "Columnar item list. Unread-only by default; pass since=<cursor> for only new items. Caps: limit 50, maxChars 2000.",
    S.listShape,
    (a) => svc.list(a),
    ro,
  );
  tool("thread_get", "read", "Last N messages of a thread + cached summary (sum) and DM reply window (win).", S.threadShape, (a) => svc.threadGet(a), ro);
  tool("item_get", "read", "One item; full=true adds untruncated text, native ids, permalink, raw.", S.itemShape, (a) => svc.itemGet(a), ro);
  tool("search", "read", "Full-text search over stored items (read and unread).", S.searchShape, (a) => svc.search(a), ro);
  tool("mark", "draft", "Batch mark read/unread or add/remove labels. upTo=<cursor> marks all up to it read.", S.markShape, (a) => svc.mark(a, actor), {
    idempotentHint: true,
  });
  tool("thread_note", "draft", "Store a ≤300-char thread summary reused by later sessions.", S.noteShape, (a) => svc.threadNote(a, actor), {
    idempotentHint: true,
  });
  tool(
    "draft_reply",
    "draft",
    "Create a reply draft (kind reply|dm|private_reply). Validates window and length. Nothing is sent until a human approves.",
    S.draftReplyShape,
    (a) => svc.draftReply(a, actor),
  );
  tool(
    "draft_moderation",
    "draft",
    "Create a moderation draft (hide|unhide|delete). Needs human approval like replies.",
    S.draftModerationShape,
    (a) => svc.draftModeration(a, actor),
  );
  tool("drafts", "read", "List drafts. Default: pending, approved, sending, failed.", S.draftsShape, (a) => svc.drafts(a), ro);
  tool(
    "send_approved",
    "send",
    "Execute an approved draft. Fails if not approved. Idempotent: re-calls return the same native id.",
    S.sendShape,
    (a) => svc.sendApproved(a.d, actor),
    { destructiveHint: true, idempotentHint: true },
  );
  tool("sync_now", "read", "Force a poll now (rate-limited). Returns new/updated counts.", S.syncShape, (a) => svc.sync({ src: a.src as never }));

  // ---- automations (deterministic flows; every message is still a draft) ----
  const canApprove = who.scopes.has("approve");
  tool("flow_list", "read", "Automation flows: id, name, on, mode, trigger summary, 7-day triggered (n7) / sent (s7).", {}, () => svc.flows.list(), ro);
  tool("flow_get", "read", "One flow's full JSON (trigger + steps).", F.flowGetShape, (a) => svc.flows.flowGet(a), ro);
  tool(
    "flow_upsert",
    "draft",
    "Create/update a flow (omit id to create; new flows are off). Validated; rejects follow-gating and other Meta policy violations. " +
      'Steps: private_reply{text,button?{title,payload|url}} public_reply{variants[1-5]} send_dm{text,buttons?|quick_replies?} ask_email{text,retry_text?} ' +
      "push_email{provider:plunk|mailerlite,tags?} tag{label} soft_follow_ask{text} handoff{note?}. mode auto needs an approve key.",
    F.flowUpsertShape,
    (a) => svc.flows.upsert(a, actor, canApprove),
  );
  tool("flow_toggle", "draft", "Switch a flow on/off.", F.flowToggleShape, (a) => svc.flows.toggle(a, actor, canApprove), { idempotentHint: true });
  tool("flow_metrics", "read", "Event counts per flow (or one flow + conversion ratios and per-media rows), skip reasons (why).", F.flowMetricsShape, (a) => svc.flows.metrics(a), ro);
  tool("flow_test", "read", "Dry-run the matcher on a text (no side effects): m=1 if it would trigger, plus the steps and draft/approve/send outcome.", F.flowTestShape, (a) => svc.flows.test(a), ro);

  if (svc.config.approval === "agent-confirmed") {
    tool(
      "approve",
      "draft",
      "Approve a draft ONLY after the human explicitly said yes in chat. Pass who confirmed and the chat message ref. Audited.",
      S.approveShape,
      (a) => svc.approve(a.d, actor, { by: a.confirmedBy, ref: a.ref }),
    );
  }
  return server;
}
