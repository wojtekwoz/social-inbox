# Changelog

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
