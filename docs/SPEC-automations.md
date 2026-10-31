# Social Inbox — SPEC addendum: Automations (M5)

Status: draft, 31 Oct 2026 · Extends SPEC.md v0.1 · Owner: wozu
Context: research page "Instagram growth automation: options" (31 Oct 2026). This milestone adds a **deterministic rules engine** for Instagram growth flows on top of the existing inbox (M0/M1). It changes one SPEC v0.1 non-goal: rule-based auto-replies become an **opt-in policy, off by default**.

## 1. Principles
1. **Rules, not AI, run the flows.** Keyword matching, lead-magnet delivery, quick replies, email capture and metrics are deterministic code. The server makes no LLM calls.
2. **AI only for what rules don't match.** Unmatched inbound items keep flowing into the inbox (labelled `needs-wozu` where appropriate) for agent digests and human-approved drafts.
3. **Safe by default.** `SENDING_ENABLED=false` and `APPROVAL=human` stay the defaults. Automations produce drafts that wait for approval unless a flow is explicitly marked `auto` **and** `AUTOMATIONS_AUTOSEND=true` **and** `SENDING_ENABLED=true`.
4. **Token-efficient, agent-first.** Flows are small JSON documents agents can read and edit via MCP/REST/CLI; list/metrics responses use the existing compact columnar format.
5. **Meta rules are enforced in code, not by convention** (§5).

## 2. Data model (new migration `002_automations.sql`)
- `flows`: `id` (short id `f…`), `name`, `enabled` (0/1), `mode` (`draft` | `auto`), `trigger` (JSON), `steps` (JSON), `created_at`, `updated_at`.
- `flow_runs`: one row per (flow, contact, trigger item): `id` (`r…`), `flow_id`, `contact_id` (IGSID), `thread_id`, `item_id`, `step` (current step index/key), `state` (`active` | `waiting_input` | `done` | `stopped` | `failed`), `vars` (JSON, e.g. captured email), `created_at`, `updated_at`.
- `flow_events`: append-only metrics log: `flow_id`, `run_id`, `type` (`triggered` | `sent` | `public_reply` | `button_tap` | `quick_reply` | `email_captured` | `email_pushed` | `skipped` | `failed`), `reason`, `ts`.
- `contacts_optout`: IGSIDs that sent STOP/opt-out keywords; never message again by automation.
- Drafts gain optional `flow_run_id` and a `payload` JSON column (buttons / quick replies) — existing drafts unaffected.

## 3. Triggers (deterministic matcher)
Matcher normalises text: lowercase, trim, strip Polish/Latin diacritics (NFD), collapse whitespace and punctuation. Match modes: `exact`, `word` (default; whole word), `contains`.
- `comment_keyword` — `{type, keywords[], match?, media_ids?: string[] | "any"}` on new `ig.cm` items not authored by us.
- `dm_keyword` — `{type, keywords[], match?}` on inbound `ig.dm` text.
- `story_reply` — `{type, keywords?[]}` on inbound DMs whose raw payload carries `story.reply_to` (optionally keyword-filtered).
- `story_mention` — on inbound DMs whose raw payload carries `story.mention`.
- `ice_breaker` / `postback` — on a postback payload (`payload` string) from ice breakers, buttons or quick replies.
First matching enabled flow wins (ordered by `priority`, then id). Each inbound item is evaluated **once** (idempotent; webhook+poll duplicates don't re-trigger).

## 4. Steps
- `private_reply` — text ≤ 640 chars with ≤ 1 button (`postback` payload or `web_url`). Only for `comment_keyword`.
- `public_reply` — comment reply chosen round-robin from 1–5 variants.
- `send_dm` — text, optional ≤ 3 buttons or ≤ 13 quick replies (`title`, `payload`), each ≤ 20 chars.
- `ask_email` — sends a prompt, sets run to `waiting_input`; next inbound DM is validated (simple RFC-ish regex); invalid → one retry message, then stop.
- `push_email` — calls an `EmailProvider` (`plunk` | `mailerlite`) with email, tags/group and source (flow id, media id). Credentials only from env (`PLUNK_API_KEY`, `MAILERLITE_API_KEY`, `MAILERLITE_GROUP_ID`); provider calls go through an interface with an in-memory fake for tests. Off unless configured.
- `tag` — adds a label to the thread/contact.
- `soft_follow_ask` — optional text shown only when `is_user_follow_business` is known false; **never** blocks delivery (no follow-gating).
- `handoff` — mark thread `needs-wozu`, end run.
Link buttons may include UTM params; a click-tracking redirect is deferred.

## 5. Send policy (enforced by the engine)
- **No follow-gating.** No step may condition delivery on following. Validation rejects such configs.
- **One private reply per comment, within 7 days** of the comment (reuse existing draft check; engine must not even create a second one).
- **24 h messaging window**: `send_dm`/`ask_email` only if the contact's last inbound message is < 24 h old (existing `window.ts`). `HUMAN_AGENT` tag is never used by automations.
- **Only people who acted first** (comment, DM, story reply/mention, postback). No follow webhook exists; no welcome-on-follow flow.
- **Opt-out**: `stop` / `stopp` / `nie pisz` / `unsubscribe` keywords → add to `contacts_optout`, stop all runs.
- **Rate limits**: respect `MAX_SENDS_PER_HOUR` and a per-contact cooldown (default one automated message per contact per flow step).
- **Execution path**: every step becomes a normal draft in the existing drafts/approval/audit pipeline. `mode: "draft"` (default) → `pending` awaiting human approval. `mode: "auto"` → auto-approved by `system:automation` only when `AUTOMATIONS_AUTOSEND=true` (default false) and still executed only if `SENDING_ENABLED=true`. Everything audited.
- Global kill switch: `AUTOMATIONS_ENABLED` (default false) disables evaluation entirely.

## 6. Webhook receiver
Existing `/webhooks/meta` (HMAC `X-Hub-Signature-256`, 401 on bad signature) stays and is extended to parse `messaging_postbacks`, quick-reply payloads (`message.quick_reply.payload`), story replies/mentions, and to feed new items to the engine. Polling stays the default in dev mode; both paths go through the same idempotent ingest → engine evaluation. Webhooks remain gated by `META_WEBHOOKS_ENABLED` until the Meta app is Live.

## 7. Agent-first API
- MCP tools: `flow_list` (compact rows: id, name, on/off, mode, trigger summary, 7-day counts), `flow_get`, `flow_upsert` (zod-validated JSON; rejects policy violations), `flow_toggle`, `flow_metrics({id?, days=7})` (counts per event type + conversion ratios), `flow_test({id, text})` (dry-run matcher, no side effects).
- REST mirrors under `/api/flows…`; CLI `sinbox flows list|get|set|on|off|metrics|test`.
- `inbox_overview` gains `auto:{triggered,sent,pending}` counts for the last 24 h.

## 8. Metrics
Per flow and per trigger media: triggered, drafts created, sent, button taps, quick-reply taps, emails captured, emails pushed, skipped (with reasons: window closed, duplicate, opted out, limit). Follows are measured only when `is_user_follow_business` is available (deferred).

## 9. Deferred (later milestones)
- Ice breakers / persistent menu publishing via `messenger_profile` (needs live API test) — engine already handles their postbacks.
- Follow check via `is_user_follow_business`; click-tracking redirect; reminder within 23 h.
- 700/h private-reply limiter beyond `MAX_SENDS_PER_HOUR`; A/B variants beyond round-robin.
- Business Verification + App Review, app Live, webhooks on (wozu-driven).

## 10. Acceptance (fixtures/fake connector only)
1. A comment "Claude!" (diacritics/case-insensitive) on a configured reel creates exactly one private-reply draft with one button; a second matching comment from the same comment id/poll+webhook duplicate creates nothing; a comment > 7 days old is skipped with reason.
2. A button-tap postback within 24 h advances the run to `ask_email`; a valid email reply is pushed to the fake Plunk/MailerLite adapter and recorded; outside 24 h the step is skipped with reason.
3. With defaults (`SENDING_ENABLED=false`, `APPROVAL=human`, `AUTOMATIONS_AUTOSEND=false`) nothing reaches the connector's `send`; with all three enabled in tests a `mode:auto` flow sends via the fake connector only.
4. `flow_metrics` returns correct counts; `flow_upsert` rejects a follow-gated config; unmatched DMs still appear in the inbox untouched.
