# Social Inbox — SPEC v0.1 (draft for wozu)

Status: draft, 31 Oct 2026 · Owner: wozu · Builder: Grok Bot + Cursor cloud agents (Opus 5.5)
Working name: `social-inbox` (rename welcome). Host: Contabo VPS via Coolify, next to Plunk and Postiz.

> One self-hosted, open-source, agent-first inbox for **Instagram, YouTube and LinkedIn**: read DMs and comments, triage, draft replies, and send or moderate **only after a human OK**. Built so an AI agent can work the inbox with as few tokens as possible.

---

## 1. Goal and non-goals

**Goal**
- One place where an agent (Grok Bot, Claude, Cursor, any MCP client) can see what's new across IG DMs, IG comments and mentions, YouTube comments and LinkedIn page comments, and draft replies.
- Everything an agent needs comes from a compact MCP server: deltas, unread-only, short IDs, cached thread summaries.
- Safe by default: no reply, hide or delete leaves the server without an explicit human approval.

**Non-goals**
- **X / Twitter.** Grok Bot already reads X DMs and mentions through its own X connector. No X connector here.
- **Publishing and scheduling.** That stays in Postiz (social.wozu.co). We only *link* items to Postiz post IDs where we can (see §4.6).
- Multi-tenant SaaS, teams, roles, billing. Single user (wozu), single workspace.
- Analytics dashboards (Postiz has them).
- Auto-replies/bots without approval (could be a later opt-in policy, off by default).
- Scraping or unofficial APIs (LinkedIn DMs, etc.). Official APIs only.

---

## 2. What each network allows (researched Oct 2026)

Legend: ✅ works · 🟡 works with limits/approval · ❌ no official API

| Capability | Instagram (Facebook Login for Business, Page-linked) | YouTube Data API v3 | LinkedIn |
|---|---|---|---|
| Read DMs | 🟡 Conversations API (poll) / `messages` webhook | ❌ YouTube has no DMs | ❌ No member messaging API (closed partner programs only) |
| Reply to DMs | 🟡 24 h window after the user's last message; 7 days with `HUMAN_AGENT` tag (separate "Human Agent" feature review) | ❌ | ❌ |
| Read comments | ✅ `GET /{media-id}/comments` (poll); 🟡 `comments` webhook | ✅ `commentThreads.list` (1 unit), poll only, no webhooks | 🟡 Company Page only, via Community Management API. Personal-post comments need `r_member_social`, which LinkedIn is **not granting** |
| Reply to comments | ✅ `POST /{comment-id}/replies` | ✅ `comments.insert` (50 units) | 🟡 Company Page via CM API (`w_organization_social`); as yourself via `w_member_social` only if you already know the post URN |
| Hide / delete | ✅ hide/unhide (`hide=true`), delete | ✅ `comments.setModerationStatus` reject/publish (50 units), optional `banAuthor`; delete only own comments | 🟡 Delete on Company Page posts via CM API |
| Mentions | 🟡 `mentions` webhook (@mentions in captions/comments); tagged media via `/{ig-user-id}/tags` (poll) | ❌ | 🟡 Org mention/social-action notifications (CM API Standard tier only) |
| Private reply to a commenter | ✅ one DM per comment, within 7 days | ❌ | ❌ |
| Story replies / story mentions | 🟡 arrive as DMs | — | — |

### 2.1 Approvals needed

**Instagram / Meta app 1829246938496408** (already exists, dev mode, wozu_co is a tester, IG linked to a FB Page):
- Permissions: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` (+ `business_management` already used by Postiz). `instagram_manage_messages` still has to be **added** to the app's use case (wozu action).
- **Standard Access (dev mode, no review):** works only for data/people with a role on the app. Expected to work: reading *your own* media comments, replying/hiding on your own media, reading your own conversations by polling. **Not** working: sending DMs to normal followers ("Apps with Standard Access can only send messages to people that have a role on the app").
- **Webhooks:** the app must be **Live**; `comments`/`live_comments` need **Advanced Access**; messaging webhooks from non-role users need Advanced Access.
- **Advanced Access = App Review + Business Verification** (Meta docs: "Business verification: required for production access"). App Review needs a privacy-policy URL, data-deletion URL/callback, a screencast per permission and test instructions. Plan 1–4 weeks; reviews can bounce.
- `HUMAN_AGENT` (7-day reply window) is a **separate** feature request; keep it behind a flag.
- Our own OAuth redirect (e.g. `https://inbox.wozu.co/oauth/meta/callback`) has to be added to the Facebook Login for Business config (wozu action). We do **not** reuse Postiz's token.

**YouTube:**
- Google Cloud project + OAuth client, scope `https://www.googleapis.com/auth/youtube.force-ssl` (sensitive scope).
- Default quota 10,000 units/day per project, resets at midnight Pacific; no audit needed at our volume.
- OAuth consent screen: if the channel belongs to a **wozu.co Workspace** account, use **Internal** (no verification, no 7-day refresh-token expiry). If it's a personal Gmail, use External + "In production" (unverified warning screen, <100 users OK). **Never leave it in "Testing"**: refresh tokens die after 7 days.
- Quota budget: polling `commentThreads.list?allThreadsRelatedToChannelId=…&order=time` every 5 min ≈ 288 units/day (+ pages). Each reply or moderation = 50 units, so ~150 actions/day fit comfortably.

**LinkedIn (be honest: mostly blocked):**
- **Member DMs:** no API for us. Out of scope.
- **Your personal posts' comments:** `r_member_social` (read) is restricted and LinkedIn says it isn't taking new requests. `w_member_social` (open, "Share on LinkedIn" product) can post a comment as you, but we can't *list* your posts or comments, so it's only useful with a pasted post URL.
- **Company Page comments** (read, reply, delete): **Community Management API**, a vetted product. Requirements: registered legal organization (commercial use), verified business email (no personal email), privacy policy, a Page super-admin verifying the app, and CM API as the **only** product on a dedicated LinkedIn app. Development tier: 500 app calls + 100 member calls / 24 h, no social-action webhooks, so polling only. Standard tier (webhooks, more volume) needs a screencast review. Your role on the Page must be ADMINISTRATOR (or DIRECT_SPONSORED_CONTENT_POSTER for reads).
- Pin the `LinkedIn-Version` header to a current version; 202511 sunsets 16 Nov 2026.
- → LinkedIn is **M3, only if** wozu has a Company Page he admins **and** a legal entity willing to apply.

---

## 3. Agent-first design

### 3.1 Principles
1. **MCP first.** Primary interface is an MCP server (Streamable HTTP at `/mcp`, bearer API key). REST and CLI are thin wrappers over the same service layer.
2. **Pay only for what's new.** Every list call is a delta: `since` cursor, default unread-only, hard caps.
3. **Short everything.** Short IDs (`i7k`, `t3f`, `d12`), short keys, relative ages, truncated text, columnar rows.
4. **Summaries are cached, not recomputed.** Thread summaries are stored; the agent writes one once (`thread_note`) and every later session reuses it. The server also keeps a free extractive summary (last inbound + counts).
5. **Never send by default.** Replies and moderation are **drafts** first. Sending needs a human approval (§3.5). All sends are idempotent and audited.
6. **The server does the boring work:** dedupe (webhook + poll overlap), threading, reply-window math, quota accounting, rule-based triage labels.

### 3.2 Unified compact item schema
Stored fully in DB; returned compactly.

```ts
type Item = {
  id: string;        // short ID, e.g. "i7k" (base36 counter, prefix by type)
  src: "ig.dm" | "ig.cm" | "ig.mn" | "yt.cm" | "li.cm";
  t: string;         // thread ID ("t3f"): DM conversation, or top-level comment + replies
  who: string;       // "@ania_k" / "Ania K" (display only)
  age: string;       // "4m" | "2h" | "3d" (absolute ts available via fields)
  x: string;         // text, truncated to maxChars (default 200) with "…"
  lbl?: string[];    // triage labels: q (question), lead, praise, spam, complaint, needs-wozu
  on?: string;       // what it's attached to: "post:p9" (our post ref), "vid:abc123"
  win?: string;      // DMs only: time left in reply window, e.g. "21h" | "closed"
  me?: 1;            // 1 if authored by wozu (outbound)
};
```
Native IDs (IGSID, comment IDs, YouTube IDs, URNs), raw payloads and media URLs stay server-side; available only with `fields:["raw"]` or `item_get(full)`.

### 3.3 Responses: columnar by default
```json
{"cols":["id","src","who","age","x","lbl","win"],
 "rows":[["i7k","ig.dm","@ania_k","12m","Hej! Ile kosztuje minikurs i czy jest dla…",["q","lead"],"23h"],
         ["i7m","yt.cm","Marek P","1h","Super odcinek, a jak zrobiłeś ten efekt…",["q"],null]],
 "next":"c_9Qx","more":false,"unread_left":0}
```
About 60–90 tokens per item versus ~600+ for raw Graph payloads. `fmt:"lines"` gives one TSV line per item for even fewer tokens.

### 3.4 MCP tools (v1)

| Tool | Signature | Notes / example response |
|---|---|---|
| `inbox_overview` | `()` | `{"unread":{"ig.dm":3,"ig.cm":7,"yt.cm":2},"closing":[["t3f","@ania_k","2h"]],"cursor":"c_9Qx","quota":{"yt":"312/10000"}}` (~50 tokens; call this first) |
| `inbox_list` | `({since?, src?, lbl?, unread=true, q?, limit=20 (max 50), maxChars=200, fields?, fmt?})` | Columnar rows (above). `since` = cursor from the last call → only new items |
| `thread_get` | `({t, last=8, maxChars=400, summary=true})` | `{"t":"t3f","sum":"Asks price of minikurs; 2nd msg; follows 2y","win":"21h","msgs":[…last N…]}` |
| `item_get` | `({id, full=false})` | Single item; `full` adds untruncated text, native IDs, permalink |
| `search` | `({q, src?, from?, to?, limit=20})` | SQLite FTS5 over stored text |
| `mark` | `({ids? , upTo?, read?, lbl_add?, lbl_rm?})` | Batch; `upTo:"c_9Qx"` marks everything up to a cursor read |
| `thread_note` | `({t, summary, tags?})` | Agent writes a cached summary (≤300 chars) reused by every later call |
| `draft_reply` | `({to, text, kind?:"reply"|"dm"|"private_reply", key?})` | Validates window, length (IG DM <1000 chars), quota. → `{"d":"d12","ok":true,"checks":["win 21h","len 182/1000"],"preview":"…"}`. `key` = idempotency key |
| `draft_moderation` | `({id, action:"hide"|"unhide"|"delete"|"reject"|"publish", banAuthor?})` | Same draft→approve flow as replies |
| `drafts` | `({status?:"pending"|"approved"|"sent"|"failed"})` | Compact list |
| `send_approved` | `({d})` | Executes a draft **only if** status=approved; idempotent (re-call returns the same native ID) |
| `sync_now` | `({src?})` | Forces a poll; returns counts of new items. Rate-limited |

**Token budget rules (server-enforced):** `limit` ≤ 50, `maxChars` ≤ 2000, `thread_get.last` ≤ 30, overall response cap ~4k tokens (truncate + `more:true`). Unknown `fields` are ignored, not echoed.

### 3.5 Approval flow ("draft → approve → send")
- Default policy `APPROVAL=human`: drafts become `approved` only through
  a) the tiny web page `/approve` (mobile-friendly list of pending drafts with Approve / Edit / Reject, behind login + passkey or strong password), or
  b) CLI on wozu's Mac: `sinbox approve d12`.
- Option to discuss (§8 Q1): `APPROVAL=agent-confirmed`: the agent may approve a draft *after* wozu said yes in chat, passing `confirmedBy` + the chat message reference; still logged.
- `dry_run` is implicit: everything is a draft until approved. Every send/moderation writes an audit row (who approved, when, native response).
- Reply-window guard: DM drafts are refused if `win` is closed; `HUMAN_AGENT` only when the feature flag is on and Meta granted it.

### 3.6 REST + CLI
- REST mirrors the tools: `GET /api/overview`, `GET /api/items?since=…`, `GET /api/threads/:t`, `POST /api/drafts`, `POST /api/drafts/:d/approve` (human-only token), `POST /api/drafts/:d/send`.
- CLI `sinbox` (same package): `sinbox ls --since last`, `sinbox thread t3f`, `sinbox approve d12`, `sinbox mcp` (stdio bridge for local clients). Stores its own cursor in `~/.config/sinbox/state.json`.

---

## 4. Architecture

```
Meta webhooks ─┐                      ┌─ MCP /mcp (agents)
               ├─► ingest ─► SQLite ◄─┼─ REST /api, CLI
pollers (IG,   │   (dedupe,  (WAL,    └─ /approve web page (human)
 YT, LI) ──────┘   thread,   FTS5)
                   triage)      │
                                └─► outbox worker ─► platform APIs (approved drafts only)
```

### 4.1 Ingestion
- **Meta:** `POST /webhooks/meta` (verify `hub.challenge` on GET; verify `X-Hub-Signature-256` HMAC-SHA256 with the app secret over the raw body, timing-safe compare; ack <1 s, process async). Fields: `messages`, `messaging_seen`, `message_reactions`, `comments`, `mentions`. **Plus pollers** that run regardless (needed in dev mode, where webhooks don't fire, and as a safety net): conversations every 2 min, recent media comments every 5 min (last 20 posts, plus older posts with new activity).
- **YouTube:** poller every 5 min (`allThreadsRelatedToChannelId`, `order=time`, stop at the last seen ID), plus `moderationStatus=heldForReview` every 30 min. Quota ledger in DB; auto-backoff at 80% of the daily quota.
- **LinkedIn (M3):** poller every 30 min over recent org posts' `socialActions/comments`; budgeted for 100 member calls/day.
- **Dedupe:** unique `(network, native_id)`; webhook and poll upserts are idempotent.

### 4.2 Storage
- **SQLite** (WAL mode, `better-sqlite3`), one file on a Docker volume. Tables: `accounts`, `threads`, `items`, `items_fts` (FTS5), `labels`, `drafts`, `audit`, `cursors`, `quota`, `tokens` (encrypted). Postgres is unnecessary for a single user and would cost ~100–200 MB RAM.
- Retention: raw payloads 30 days; item text 12 months (configurable); then purge text, keep IDs/stats.

### 4.3 Queue / jobs
- No Redis. In-process scheduler (`croner`) + a SQLite-backed `jobs` table for outbox sends with retry/backoff (exponential, max 5) and a per-network rate limiter.

### 4.4 Auth
- Single user. API keys (random 32 bytes, stored as SHA-256 hashes) with scopes: `read`, `draft`, `send`, `approve`. Default agent key = `read+draft+send` (send only works on approved drafts); `approve` key only for the human page/CLI.
- `/approve` web: password (argon2id) + optional passkey; session cookie, `SameSite=Strict`.
- Public routes: `/webhooks/meta`, `/oauth/*/callback`, `/privacy`, `/data-deletion`, `/healthz`. Everything else needs auth.

### 4.5 Deploy (Coolify, same VPS)
- One container (Node 22 LTS, distroless or alpine), Coolify "Dockerfile" app in the existing project, domain `inbox.wozu.co` (needs a Porkbun A record → 144.91.85.126, wozu action), Let's Encrypt via Traefik.
- **RAM budget: ≤ 192 MB limit** (expected 80–120 MB idle). VPS currently has ~3.8 GiB available after Postiz, so it fits with plenty of room; no extra DB containers.
- Backups: add `sqlite3 .backup` (online, consistent) of the DB file to the existing nightly `wozu-backup` Restic job → Frankfurt S3. Restore test in the weekly isolated check.
- Health: `/healthz` + include in the existing CloudWatch heartbeat later.

### 4.6 Postiz linking (nice-to-have, M4)
- Postiz public API key (already exists) → periodically fetch Postiz posts and map IG media IDs / YouTube video IDs to Postiz post IDs. Items then carry `on:"post:p9"` and `inbox_list({on:"p9"})` filters "comments on that post I scheduled".

### 4.7 Secrets
- Coolify env (never in the repo): `META_APP_ID`, `META_APP_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `LI_CLIENT_ID/SECRET`, `TOKEN_ENC_KEY` (32 bytes), `WEBHOOK_VERIFY_TOKEN`.
- OAuth access/refresh tokens stored in DB encrypted with AES-256-GCM (`TOKEN_ENC_KEY`); key rotation command.
- Local copies only in `~/.config/wozu-stack/` (0600). `.gitignore` + `gitleaks` pre-commit and CI scan before anything goes public.

---

## 5. Tech stack, license, repo

**Stack (small footprint, TypeScript end to end):**
- Node 22 LTS, TypeScript (strict), **Hono** (HTTP), `@modelcontextprotocol/sdk` (Streamable HTTP + stdio), `better-sqlite3` + **Kysely** (typed SQL, no heavy ORM), `zod` (tool schemas), `croner` (schedules), `pino` (logs, PII-redacted), `vitest` (tests with recorded API fixtures), `commander` (CLI).
- No frontend framework: `/approve` is server-rendered HTML (~1 file).

**License: MIT (recommended).** It's an original codebase (no Postiz code copied, so no AGPL inheritance), MIT maximizes adoption and agent tooling reuse, and wozu doesn't need copyleft protection for a personal tool. Choose **AGPL-3.0** instead only if you want hosted forks to share their changes (that's why Postiz uses it).

**Repo layout:**
```
social-inbox/
  SPEC.md  README.md  LICENSE  .env.example  Dockerfile  coolify.compose.yaml
  src/
    server.ts            # Hono app: routes, auth, webhooks
    mcp/tools.ts         # tool defs (zod) → service calls
    api/routes.ts
    cli/index.ts         # `sinbox`
    core/                # schema.ts ids.ts store.ts triage.ts drafts.ts window.ts quota.ts compact.ts
    connectors/
      meta/              # oauth.ts webhook.ts poll.ts send.ts
      youtube/
      linkedin/
      fake/              # deterministic fake connector for tests & demos
    jobs/scheduler.ts outbox.ts
    web/approve.ts privacy.ts
  migrations/
  test/ fixtures/ (recorded, scrubbed API responses)
```

---

## 6. Security and privacy
- **Webhook signature verification** mandatory (reject unsigned/invalid with 401, log count only).
- **OAuth `state`** + PKCE where supported; strict redirect URI allowlist.
- **Least privilege:** request only the scopes in §2.1; no `ads_*`, no publishing scopes (Postiz has those).
- **Tokens encrypted at rest**; never logged; API keys hashed.
- **GDPR-ish:** we process third-party personal data (commenters, DM senders) under legitimate interest for managing wozu's own accounts. Publish `/privacy` (also required by Meta App Review) and `/data-deletion` (Meta data-deletion callback: deletes all items of a given IGSID). Retention limits (§4.2). Data stays in the EU (Contabo EU + Frankfurt backups). Export/delete-by-person command in CLI.
- **No content leaves the server** except to the platform APIs and to the authenticated agent. No third-party LLM calls inside the server (summaries come from the agent via `thread_note`).
- **Abuse guards:** per-key rate limits, max 30 sends/hour default, kill switch `SENDING_ENABLED=false` (default **false** until wozu flips it).
- **Audit log** of every approval, send and moderation, append-only.

---

## 7. Milestones (sized for Cursor cloud agents, Opus 5.5)
Each milestone = 1–3 agent runs, merged via PR that wozu (or Builder) reviews. No real credentials in agent runs; connectors tested against recorded fixtures, live tests done by Builder on the VPS.

**M0: Skeleton (no platform credentials needed)**
- Repo, schema + migrations, short IDs, compact formatter, MCP + REST + CLI over a `fake` connector, drafts/approval/audit, Dockerfile.
- ✅ Accept: `vitest` green; `inbox_overview`/`inbox_list` responses for 20 fake items are < 1,500 tokens; `since` returns only new items; `send_approved` on an unapproved draft fails; double `send_approved` sends once; container idles < 150 MB.

**M1: Instagram (DMs + comments read, draft reply)**
- Meta OAuth (Facebook Login for Business config), Page token, pollers (conversations, media comments, tags), webhook endpoint with signature check, reply-window tracking, drafts for DM reply / comment reply / private reply / hide / delete, `/privacy` + `/data-deletion`.
- ✅ Accept (dev mode): last 30 days of wozu_co conversations and comments appear within 5 min; a test DM from a tester account shows up and can be replied to after approval; a comment on wozu_co can be replied to and hidden after approval; invalid webhook signature → 401; DM draft outside 24 h is refused with a clear reason.
- **M1b (wozu-driven, parallel):** business verification + App Review for `instagram_manage_messages`, `instagram_manage_comments` (+ Human Agent optional), then flip app to Live and enable webhooks. ✅ Accept: a DM from a non-tester account arrives via webhook in < 10 s and can be answered.

**M2: YouTube comments**
- Google OAuth (Internal or In-production consent), channel poller, held-for-review poller, reply + reject/publish drafts, quota ledger.
- ✅ Accept: new comment appears within 5 min; reply after approval shows on YouTube; daily quota use at idle < 500 units; backoff kicks in at 80%.

**M3: LinkedIn Company Page (only if CM API is approved)**
- LinkedIn OAuth, org post comments poller, reply/delete drafts, 100-calls/day budget.
- ✅ Accept: comments on the last 10 Page posts sync within 30 min; reply after approval appears on the post; never exceeds the dev-tier budget.

**M4: Polish**
- Postiz linking, triage rule tuning, daily digest tool (`inbox_digest`, ≤ 300 tokens), backups wired into `wozu-backup`, gitleaks CI, README for open-source release.

---

## 8. Open questions for wozu
1. **Approval:** should sends be approved only on the `/approve` page or CLI, or may Grok Bot approve a draft after you've said "yes" in chat?
2. **Meta review:** are you OK doing Business Verification + App Review (business documents, privacy page, a short screencast)? Without it, sending DMs and live webhooks only work with tester accounts. Reading your own comments and replying to them should still work.
3. **LinkedIn:** do you admin a LinkedIn **Company Page** (e.g. Wozu / Vibe Hero) and have a registered business to apply for the Community Management API? If not, LinkedIn drops out (personal DMs and personal-post comments aren't available to anyone).
4. **YouTube:** which Google account owns the channel, `yo@wozu.co` (Workspace) or the personal Gmail? It decides the OAuth setup.
5. **Repo + domain:** public GitHub repo name/owner (e.g. `wozu/social-inbox`), MIT OK, and `inbox.wozu.co` as the subdomain?

---

### Sources (checked 31 Oct 2026)
- Meta: Instagram Webhooks setup & fields (developers.facebook.com/documentation/instagram-platform/webhooks/setup, …/webhooks/fields); Instagram Platform overview; Messenger API for Instagram, Send a Message (Standard Access limitation); Instagram API with Unified Login; App Review for Instagram API; Send Messages (Human Agent, 24 h / 7 day windows).
- YouTube: Quota calculator (developers.google.com/youtube/v3/determine_quota_cost); comments.setModerationStatus; Implementation: Comments; Quota and compliance audits.
- LinkedIn: Comments API (li-lms-2026-09); Community Management overview & migration guide (vetting, dev tier 500/100 calls, no webhooks); Posts API (`r_member_social` restricted); Getting Access (open permissions: `w_member_social`).
