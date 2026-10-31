# Build report — M0 + M1 (2026-10-31)

Scope: SPEC v0.1 milestones **M0 (skeleton)** and **M1 (Instagram)**. No real credentials were used. Every Instagram behaviour is tested against mocked Graph API fixtures (`test/fixtures/meta/*.json`, scrubbed and built from the documented shapes).

**Verification run locally (macOS, Node 23.7):** `tsc --noEmit` is clean, `vitest`: **49/49 passing** (3 files), `npm run build` is OK, and `node scripts/smoke.mjs` is OK (built server + CLI + stdio MCP bridge + RSS check).

## Acceptance criteria

### M0 — Skeleton

| Criterion | Status | Evidence |
|---|---|---|
| `vitest` green | ✅ | 49 tests: `test/core.test.ts`, `test/http.test.ts`, `test/meta.test.ts` |
| `inbox_overview` + `inbox_list` for 20 fake items < 1,500 tokens | ✅ | Measured ≈ **75 + 746 = ~820** estimated tokens (`core.test.ts` "under 1,500 tokens"). `fmt:"lines"` ≈ 640. Estimate = JSON chars ÷ 3, which errs high; no real tokenizer offline. |
| `since` returns only new items | ✅ | `core.test.ts` "`since` returns only new items", plus the MCP round-trip in `http.test.ts` |
| `send_approved` on an unapproved draft fails | ✅ | Unit test, REST (409) and MCP (`isError`, "not approved") |
| Double `send_approved` sends once | ✅ | Sequential (second call returns `dup:true` + same native id) **and** concurrent (atomic `approved→sending` claim); connector called once, one `sent` audit row |
| Container idles < 150 MB | ⚠️ partly | Process RSS **≈101 MB** after 200 requests (smoke script, macOS arm64, `--max-old-space-size=96`). **Docker image not built locally**: Docker commands weren't available in this session. The CI `docker` job builds the image, loads it, and fails if `docker stats` ≥ 150 MB. It has never run yet. |

M0 scope items: repo, schema + migrations, short IDs, compact formatter, MCP + REST + CLI over the fake connector, drafts/approval/audit, Dockerfile. All are done.

### M1 — Instagram (dev mode)

| Criterion | Status | Evidence / notes |
|---|---|---|
| Last 30 days of conversations and comments appear within 5 min | ✅ mocked | Pollers run conversations every 2 min, comments every 5 min, tags every 15 min. The 30-day backfill cutoff is tested (an August conversation is excluded). Re-polls are idempotent, and comments are only re-fetched when `comments_count` changes. **Not run against the real Graph API.** |
| A test DM from a tester shows up and can be replied to after approval | ✅ mocked | Webhook path (signed delivery → item with resolved `@username`, dedupe on redelivery) and poll path. The send asserts the exact Graph call `POST /{page-id}/messages {recipient:{id}, message:{text}, messaging_type:"RESPONSE"}`. In real dev mode webhooks don't fire, so the DM arrives via the 2-min poller. |
| A comment can be replied to and hidden after approval | ✅ mocked | Asserts `POST /{top-level-comment-id}/replies?message=…` and `POST /{comment-id}?hide=true`; the item shows `[hidden]` locally. Delete and private reply are also covered. |
| Invalid webhook signature → 401 | ✅ | Wrong secret, garbage and missing header all return 401 and nothing is ingested; only a counter is kept (bodies are never logged). The GET handshake is tested too. |
| DM draft outside 24 h is refused with a clear reason | ✅ | `"reply window closed: last message from @marek.p was 2d ago (limit 24h)"`. Checked again at approval and at send. A `HUMAN_AGENT` 7-day path exists behind `META_HUMAN_AGENT`. |

M1 scope items:
- Meta OAuth (Facebook Login for Business, `config_id` supported) gets a long-lived user token and then a Page token, both AES-256-GCM encrypted. State is single-use and tested.
- Pollers: conversations, media comments, tags.
- Webhook endpoint with signature check, behind `META_WEBHOOKS_ENABLED`.
- Reply-window tracking.
- Drafts for DM reply, comment reply, private reply, hide/unhide and delete.
- `/privacy` and `/data-deletion`, with `signed_request` verification tested.

All are done. M1b (business verification, App Review, going Live) is owner-driven; see below.

## Owner defaults applied

- **Approvals** go through CLI/REST (`POST /api/drafts/:d/approve`, needs an `approve`-scoped key). The MCP `approve` tool only exists with `APPROVAL=agent-confirmed` and requires `confirmedBy` + `ref`, which are audited.
- **`SENDING_ENABLED=false`** by default. It is a kill switch for every platform write.
- Single-user API keys (stored as SHA-256) with scopes `read`/`draft`/`send`/`approve`. Defaults are an agent key (no approve) and an admin key.
- SQLite in a single container, a Coolify compose example with a 192 MB limit, and `inbox.wozu.co` as the default `PUBLIC_URL`.
- X/Twitter: not present.

## Deviations from SPEC (deliberate, small)

- **No Kysely.** Raw `better-sqlite3` prepared statements: one less dependency and less RAM, and the queries are simple.
- **No `/approve` web page** (and so no argon2/passkey login). The owner chose CLI/REST approval. The REST endpoint is ready if a page is wanted later.
- Labels are a JSON column on `items` rather than a `labels` table. The outbox uses `drafts.attempts/next_at` rather than a separate `jobs` table. The `quota` table is deferred to M2 (YouTube).
- MCP runs **stateless with JSON responses** (a fresh server per request, no SSE or server-initiated notifications). That keeps memory flat. None of the v1 tools need streaming.
- `closing` in `inbox_overview` lists unanswered DMs whose window closes within **6 h** (top 5).
- Added `sinbox edit`, `sinbox moderate`, `sinbox note`, `PATCH /api/drafts/:d` and `?send=1` on approve for convenience.

## Mocked / untested — verify on the VPS

1. **Real Graph API.** The fixture shapes follow Meta's docs but have not been checked against live responses. Check these first:
   - `GET /{page-id}/conversations?platform=instagram&fields=id,updated_time,participants`
   - `GET /{conv-id}/messages?fields=id,created_time,from,to,message,attachments,story,is_unsupported`
   - comment fields `from`, `hidden`, `replies{…}`
   - `GET /{ig-user-id}/tags`
   - the `mentioned_comment.comment_id(...)` / `mentioned_media.media_id(...)` field syntax
   - sending via `POST /{page-id}/messages` with the Page token
   - private reply `recipient:{comment_id}`
2. **Graph version** defaults to `v24.0` (`META_GRAPH_VERSION`). Confirm it's current.
3. **Webhook payloads** were built from the docs (`object: "instagram"`, `entry[].messaging[]` / `entry[].changes[]`). Page subscription (`POST /{page-id}/subscribed_apps`) is **not automated**; set it up in the App Dashboard.
4. **Usernames for webhook DMs** come from a best-effort `GET /{igsid}?fields=username`. If that fails, the poller fills them in later.
5. **Data-deletion callback:** Meta's `user_id` there is the app-scoped ID of the Facebook user who used the app (that's you), *not* commenter IGSIDs. Per-person deletion for commenters/DM senders is `sinbox admin forget <igsid>` (and `export <igsid>`).
6. **Docker image build, the CI workflow and the gitleaks action** have never run. They'll run on the first push or PR.
7. Token counts use a chars÷3 heuristic, not a real tokenizer.
8. Rate limiting (per key, 300 req/min) and the sync cooldown are in-memory, which is fine for one process.

## What the owner needs to do to go live

1. **Commit/push**: nothing has been committed. Git writes needed interactive approval this session (see the commit plan in the hand-off message). Then push the branch and open a PR so CI runs.
2. **DNS:** A record `inbox.wozu.co → 144.91.85.126` (Porkbun).
3. **Coolify:** new resource (Dockerfile or `coolify.compose.yaml`), volume at `/data`, 192 MB limit, domain `https://inbox.wozu.co`. Env vars:
   - `SINBOX_AGENT_KEY`, `SINBOX_ADMIN_KEY`: generate both
   - `TOKEN_ENC_KEY`: `openssl rand -hex 32`
   - `META_APP_ID=1829246938496408`, `META_APP_SECRET`
   - `PUBLIC_URL`, `PRIVACY_CONTACT`
   - Keep `SENDING_ENABLED=false` at first.
4. **Meta app (dev mode):**
   - Add `instagram_manage_messages` to the use case.
   - Add `https://inbox.wozu.co/oauth/meta/callback` to the Facebook Login for Business redirect URIs. Optionally create a Login Configuration and set `META_LOGIN_CONFIG_ID`.
   - Make sure `wozu_co` and any test-DM accounts have app roles.
5. **Connect:** `sinbox --url https://inbox.wozu.co --key <admin> connect meta`, open the URL, and pick the Page linked to @wozu_co. Then `sinbox sync` and `sinbox ov`.
6. **Live test:** send a DM from a tester account, reply via `sinbox draft` → `approve --send` with `SENDING_ENABLED=true`. Do the same with a comment reply and a hide.
7. **Agents:** give Grok Bot / Claude the *agent* key and the MCP URL (README → "Client config"). Keep the admin key on your Mac only.
8. **Backups:** add `sqlite3 /data/inbox.db ".backup …"` to the nightly `wozu-backup` Restic job.
9. **M1b (parallel):**
   - Business Verification, then App Review for `instagram_manage_messages` and `instagram_manage_comments` (optionally Human Agent). Use `/privacy` and `/data-deletion` as the URLs, with screencasts.
   - Switch the app to Live and subscribe the webhooks (`messages`, `comments`, `mentions`) to `https://inbox.wozu.co/webhooks/meta` with `WEBHOOK_VERIFY_TOKEN`.
   - Set `META_WEBHOOKS_ENABLED=true`.
