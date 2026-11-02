# Changelog

## Unreleased — Tester-only send path

### Changed (breaking default)
- New `SEND_MODE` (`off` | `testers` | `all`, default **`off`**) gates every approved-draft execution on top of `SENDING_ENABLED`. **With `SEND_MODE` unset nothing is sent, even with `SENDING_ENABLED=true`.** Set `SEND_MODE=all` to keep the previous behaviour.

### Added
- `SEND_MODE=testers` + `SEND_ALLOWLIST` (comma-separated IGSIDs and/or usernames, case-insensitive, `@` optional): only allowlisted recipients (DM counterpart, or the author of the comment being replied to / private-replied to / moderated) are sent to. Other drafts are marked `failed` without retry and audited as `send_blocked`. Covers manual and automation drafts; `push_email` is skipped as `not_tester`.
- `inbox_overview` always shows `send: "off" | "testers(N)" | "all"` (not in `/healthz`). The startup log includes `sendMode` and the tester count.

## Unreleased — M5 Automations engine

Implements [docs/SPEC-automations.md](docs/SPEC-automations.md). Everything is off by default (`AUTOMATIONS_ENABLED=false`, `AUTOMATIONS_AUTOSEND=false`). `SENDING_ENABLED=false` and `APPROVAL=human` are unchanged.

### Added
- Migration `002_automations.sql`: `flows`, `flow_runs`, `flow_events` (append-only metrics log), `contacts_optout`, a `flow_seen` evaluation ledger, and `drafts.flow_run_id` + `drafts.payload`. Existing drafts are unaffected.
- `src/automations/`: deterministic matcher (case, diacritics incl. `ł`, punctuation; `exact` / `word` / `contains`), triggers (`comment_keyword`, `dm_keyword`, `story_reply`, `story_mention`, `postback` / `ice_breaker` for buttons, quick replies and ice breakers), and an engine that evaluates each new inbound item exactly once across webhook and poll duplicates.
- Steps: `private_reply` (≤1 button), `public_reply` (round-robin over 1–5 variants), `send_dm` (≤3 buttons or ≤13 quick replies), `ask_email` (validation, one retry, then stop), `push_email`, `tag`, `soft_follow_ask` (never blocks), `handoff`. A postback button arms the run, and later DM steps wait for the tap.
- Send policy enforced in code: follow-gating rejected at validation (no follow trigger exists), one private reply per comment within 7 days, DM steps only inside the standard 24 h window (automations never use `HUMAN_AGENT`, at draft, approval and send), whole-message opt-out keywords, per-contact per-step cooldown (`AUTOMATIONS_COOLDOWN_HOURS`, default 24), `MAX_SENDS_PER_HOUR` cap on automated drafts, and items from before a flow was switched on never trigger it.
- Every step message is a draft in the existing approval/audit pipeline. `mode: "auto"` flows are approved by `system:automation` only with `AUTOMATIONS_AUTOSEND=true`, and executed only with `SENDING_ENABLED=true`. Only `approve`-scoped keys can create, edit or switch on `auto` flows.
- `EmailProvider` interface with Plunk (`/v1/track`) and MailerLite (`/api/subscribers`) adapters over an injectable fetch, plus an in-memory fake. Keys only from env. Pushing is an external write, so it also needs `SENDING_ENABLED=true`.
- Meta connector: private replies and DMs with button templates and quick replies (from `drafts.payload`). The webhook parser handles `messaging_postbacks`, `message.quick_reply.payload`, story replies and story mentions (normalised to the poller's `story` shape). HMAC verification is unchanged.
- Metrics: `flow_metrics` counts per flow (triggered, drafted, sent, public replies, taps, quick replies, emails captured/pushed, skipped with reasons, failed), with conversion ratios and per-media rows for a single flow.
- Agent API: MCP `flow_list`, `flow_get`, `flow_upsert`, `flow_toggle`, `flow_metrics`, `flow_test` (dry run); REST `/api/flows…`; CLI `sinbox flows list|get|set|on|off|metrics|test`. `inbox_overview` gains `auto: {triggered, sent, pending}`, and the `drafts` list shows the originating run (`auto`).
- New `auto` triage label marks items consumed by a flow; unmatched items are left untouched.

### Deferred
Ice breaker / persistent menu publishing via `messenger_profile`, follow check via `is_user_follow_business`, click-tracking redirect, reminders within 23 h, A/B testing beyond round-robin, Meta App Review. See docs/SPEC-automations.md §9 and docs/REPORT-automations.md.

## 0.1.0 — 2026-10-31

M0 (skeleton) and M1 (Instagram) from SPEC v0.1.

### Added
- SQLite storage (WAL, FTS5) with SQL migrations: accounts, encrypted tokens, posts, threads, items, drafts, append-only audit, cursors, API keys, OAuth states, deletion records.
- Short IDs (`i…`, `t…`, `d…`, `p…`) and opaque delta cursors (`c_…`).
- Compact columnar responses with automatic empty-column dropping, `fmt: "lines"` TSV mode, field selection, and hard caps (limit 50, maxChars 2000, thread 30, ~4k-token response cap).
- Rule-based triage labels (EN + PL): `q`, `lead`, `praise`, `spam`, `complaint`, `needs-wozu`.
- Draft → approve → send flow: reply / DM / private reply / hide / unhide / delete. Idempotency keys, an atomic send claim (a draft is sent at most once), retries with backoff on transient errors (up to 5), and crash recovery that never re-sends. Also a `SENDING_ENABLED=false` kill switch, a 30 sends/h cap, and a full audit log.
- Reply-window math (24 h, 7 d with `HUMAN_AGENT` behind a flag) checked at draft time, approval and send.
- MCP server (Streamable HTTP at `/mcp`, stateless) with the 12 v1 tools. An `approve` tool exists only with `APPROVAL=agent-confirmed`.
- REST API that mirrors the tools. Approval needs an `approve`-scoped key.
- `sinbox` CLI: REST client, saved `--since last` cursor, a stdio MCP bridge (`sinbox mcp`), and local admin commands (keys, export/forget a person, token-key rotation).
- Deterministic fake connector for tests and demos.
- Instagram connector (Facebook Login for Business, Page-linked):
  - OAuth with single-use state, long-lived user token, then a Page token stored with AES-256-GCM.
  - Pollers for conversations, media comments (count-diffed) and tags, with 30-day backfill.
  - Webhooks (behind a flag) with HMAC-SHA256 signature verification and async processing that dedupes against polling.
  - Mention lookups.
  - Sends via Graph with `appsecret_proof`.
- `/privacy` page and Meta data-deletion callback (verified `signed_request`) with a status page.
- Retention purge (raw payloads 30 d, text 12 mo), in-process scheduler (croner).
- Dockerfile (Node 22 alpine, non-root, healthcheck), Coolify compose example (192 MB limit), and GitHub Actions CI covering typecheck, tests, build, smoke test, Docker build + health check, and gitleaks.
