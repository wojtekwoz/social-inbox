# Social Inbox

Self-hosted, agent-first inbox for **Instagram** DMs, comments and mentions (YouTube and LinkedIn are planned, X/Twitter is out of scope).
The main interface is an **MCP server** for AI assistants. A compact REST API and a small CLI (`sinbox`) sit on the same service layer.

- **Token-light by design.** Responses are columnar, IDs are short (`i7k`, `t3f`, `d12`), lists are unread-only by default, `since` cursors return deltas, limits are capped, you can pick fields, and thread summaries are cached. Overview + a 20-item list is about 800 tokens.
- **Nothing is sent without a human.** Replies, hides and deletes start as **drafts**. A human approves them with the CLI or REST using an `approve`-scoped key. Real sending is **off** until you set `SENDING_ENABLED=true`. Sends are idempotent, rate-limited (30/h) and audited in an append-only log.
- **Small.** One Node 22 container with SQLite (WAL + FTS5). There is no Redis and no Postgres. It uses about 100 MB RSS.

See [SPEC.md](SPEC.md) for the full design and [CHANGELOG.md](CHANGELOG.md) for what is implemented.

## Quick start (local, no credentials)

```bash
npm ci && npm run build
FAKE_CONNECTOR=true SENDING_ENABLED=true \
SINBOX_AGENT_KEY=sk_agent_dev SINBOX_ADMIN_KEY=sk_admin_dev \
DB_PATH=./data/dev.db npm start

# another terminal
export SINBOX_URL=http://localhost:8787 SINBOX_KEY=sk_agent_dev
node dist/cli/index.js sync
node dist/cli/index.js ls
node dist/cli/index.js draft i1 "Hej! Minikurs kosztuje 99 zł."
node dist/cli/index.js --key sk_admin_dev approve d1 --send
```

`node scripts/smoke.mjs` runs the same flow automatically and checks memory.

## MCP

Endpoint: `POST https://inbox.wozu.co/mcp` (Streamable HTTP, stateless, JSON responses), header `Authorization: Bearer <agent key>`.

| Tool | Purpose |
|---|---|
| `inbox_overview` | Unread counts per source, DM windows closing within 6h, head cursor. Call first. |
| `inbox_list` | Columnar items. `since`, `src`, `lbl`, `unread` (default true), `q`, `on`, `t`, `limit` (≤50), `maxChars` (≤2000), `fields`, `fmt: "lines"` |
| `thread_get` | Last N messages (≤30), cached or extractive summary, reply window |
| `item_get` | One item; `full` adds untruncated text, native IDs, permalink, raw |
| `search` | FTS5 over stored text |
| `mark` | Batch read/unread and labels; `upTo: <cursor>` |
| `thread_note` | Store a ≤300-char summary that later sessions reuse (`new_since_sum` shows staleness) |
| `draft_reply` | `kind: reply \| dm \| private_reply`; checks reply window, length and the one-private-reply rule; `key` = idempotency key |
| `draft_moderation` | `hide \| unhide \| delete` |
| `drafts` | List drafts |
| `send_approved` | Executes **only** approved drafts; re-calls return the same native ID |
| `sync_now` | Forces a poll (rate-limited to once per 30 s) |
| `approve` | **Only** when `APPROVAL=agent-confirmed`. Needs `confirmedBy` + chat `ref`, both audited |

Example `inbox_list` response:

```json
{"cols":["id","src","t","who","age","x","lbl","win"],
 "rows":[["i1","ig.dm","t1","@ania_k","2h","Hej! Ile kosztuje minikurs…",["q","lead","needs-wozu"],"21h"]],
 "next":"c_k","more":false}
```

Columns that are empty for every row are dropped automatically.

### Client config

**Claude Code** (HTTP):

```bash
claude mcp add --transport http social-inbox https://inbox.wozu.co/mcp \
  --header "Authorization: Bearer $SINBOX_AGENT_KEY"
```

**Claude Desktop / Cursor / any stdio client** (through the CLI bridge):

```json
{
  "mcpServers": {
    "social-inbox": {
      "command": "node",
      "args": ["/path/to/social-inbox/dist/cli/index.js", "mcp"],
      "env": { "SINBOX_URL": "https://inbox.wozu.co", "SINBOX_KEY": "sk_..." }
    }
  }
}
```

(Run `npm ci && npm run build` in the checkout first.)

**Clients that support remote HTTP servers with headers** (Cursor `mcp.json`):

```json
{ "mcpServers": { "social-inbox": { "url": "https://inbox.wozu.co/mcp", "headers": { "Authorization": "Bearer sk_..." } } } }
```

## REST

All routes need `Authorization: Bearer <key>`. Scopes: `read`, `draft`, `send`, `approve`.

| Method | Path | Scope |
|---|---|---|
| GET | `/api/overview` | read |
| GET | `/api/items?since=&src=ig.dm,ig.cm&lbl=&unread=0&q=&on=&t=&limit=&maxChars=&fields=&fmt=lines` | read |
| GET | `/api/items/:id?full=1` | read |
| GET | `/api/threads/:t?last=` | read |
| PUT | `/api/threads/:t/note` `{summary,tags}` | draft |
| GET | `/api/search?q=` | read |
| POST | `/api/mark` `{ids,upTo,read,lbl_add,lbl_rm}` | draft |
| GET | `/api/drafts?status=` · `/api/drafts/:d` | read |
| POST | `/api/drafts` `{to,text,kind,key}` | draft |
| POST | `/api/drafts/moderation` `{id,action,key}` | draft |
| PATCH | `/api/drafts/:d` `{text}` (pending only) | draft |
| POST | `/api/drafts/:d/approve[?send=1]` · `/api/drafts/:d/reject` | **approve** |
| POST | `/api/drafts/:d/send` | send |
| POST | `/api/sync` `{src}` | read |
| POST | `/api/oauth/meta/start` → `{url}` | approve |

Public routes: `/healthz`, `/privacy`, `/data-deletion` (Meta callback + status page), `/webhooks/meta`, `/oauth/meta/callback`.

## CLI (`sinbox`)

```
sinbox login <url> <key>          # saves ~/.config/sinbox/config.json (0600)
sinbox ov                         # overview
sinbox ls [--since last] [--all] [--src ig.dm] [--lbl lead]
sinbox thread t3f | item i7k [--full] | search "minikurs"
sinbox mark i1 i2 [--unread] | note t3f "summary"
sinbox draft <i|t> "text" [--kind dm|reply|private_reply] | moderate i7k hide
sinbox drafts [--status pending] | show d12 | edit d12 "new text"
sinbox approve d12 [--send] | reject d12 | send d12
sinbox sync [ig.dm] | connect meta | mcp
sinbox admin key-create --name agent2 --scopes read,draft,send   # runs on the server (DB_PATH)
sinbox admin key-list | key-revoke <name> | export <igsid> | forget <igsid> | rotate-key --old K --new K
```

Use the **admin** key (with `approve`) only on your own machine. Give agents the **agent** key.

## Instagram setup (Meta)

The app is the existing Meta app with **Instagram API via Facebook Login for Business**. The Instagram professional account must be linked to a Facebook Page.

1. **Permissions** (Use case → Instagram API / Messenger for Instagram): `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`. `instagram_manage_messages` must be **added** to the use case. No publishing or ads scopes.
2. **Facebook Login for Business → Settings → Valid OAuth Redirect URIs:** add `https://inbox.wozu.co/oauth/meta/callback`. Optionally create a Login **Configuration** with the permissions above and set `META_LOGIN_CONFIG_ID`. Without it, the scopes are passed explicitly.
3. **Env:** set `META_APP_ID`, `META_APP_SECRET`, `TOKEN_ENC_KEY` (`openssl rand -hex 32`) and `PUBLIC_URL`.
4. **Connect:** `sinbox --key <admin key> connect meta` prints a login URL. Open it, choose the Page linked to `@wozu_co`, and you'll be redirected back. The server exchanges the code for a long-lived user token and then a non-expiring Page token. It stores both encrypted (AES-256-GCM) and finds the linked IG account.
5. **Polling** starts on its own: conversations every 2 min, media comments every 5 min (comments are only fetched for posts whose `comments_count` changed), tags every 15 min. The first run backfills 30 days.
6. **Webhooks (optional, M1b):** need a **Live** app and **Advanced Access**. In App Dashboard → Webhooks → Instagram, set the callback to `https://inbox.wozu.co/webhooks/meta` with your `WEBHOOK_VERIFY_TOKEN`, subscribe to `messages`, `comments`, `mentions` (and optionally `messaging_seen`, `message_reactions`), then set `META_WEBHOOKS_ENABLED=true`. Every POST is checked against `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, timing-safe compare). Unsigned or invalid requests get 401.
7. **App Review needs:** privacy policy URL `https://inbox.wozu.co/privacy` and data-deletion callback `https://inbox.wozu.co/data-deletion`. Both are served by the app.

**Dev-mode limits (Standard Access):** you can read your own comments and conversations and reply to or hide comments on your own media. DMs can only be **sent** to people with a role on the app (testers). Webhooks don't fire until the app is Live with Advanced Access, which is why polling always runs.

**Reply rules enforced at draft time, again at approval, and again at send:** DMs can only be sent within 24 h of the user's last message. With `META_HUMAN_AGENT=true` (a separate Meta feature) that becomes 7 days. Messages are limited to 1000 chars. Private replies are limited to one per comment, within 7 days. Comment replies are limited to 2200 chars and always go to the top-level comment.

## Automations

A small, **deterministic** rules engine for Instagram growth flows: keyword comment → private reply with a button → tap → DM / email capture → push to Plunk or MailerLite. There are no LLM calls. Anything a rule doesn't match stays in the inbox untouched for agents and humans. Design: [docs/SPEC-automations.md](docs/SPEC-automations.md).

- **Off by default.** `AUTOMATIONS_ENABLED=false`. New flows are created switched off.
- **Still drafts.** Every message a flow wants to send becomes a normal draft in the approval queue (`drafts` shows `auto: r…`). A `mode: "auto"` flow approves its own drafts as `system:automation` **only** with `AUTOMATIONS_AUTOSEND=true`, and they are executed **only** with `SENDING_ENABLED=true`. Only `approve`-scoped keys can create, edit or switch on `auto` flows.
- **Meta rules in code:** follow-gating is rejected at validation, one private reply per comment within 7 days, DMs only inside the 24 h window (never `HUMAN_AGENT`), opt-out on `stop` / `stopp` / `nie pisz` / `unsubscribe` (whole message), a per-contact cooldown (`AUTOMATIONS_COOLDOWN_HOURS`, default 24) and `MAX_SENDS_PER_HOUR`.
- **Triggers:** `comment_keyword` (optionally per post), `dm_keyword`, `story_reply`, `story_mention`, `postback` / `ice_breaker` (buttons, quick replies, ice breakers). Matching ignores case, diacritics and punctuation (`exact` | `word` (default) | `contains`). Each inbound item is evaluated once, even when it arrives via both webhook and poll.
- **Steps:** `private_reply` (≤1 button), `public_reply` (1–5 variants, round-robin), `send_dm` (≤3 buttons or ≤13 quick replies), `ask_email`, `push_email`, `tag`, `soft_follow_ask` (never blocks), `handoff`.

```json
{"name":"Claude guide","enabled":true,
 "trigger":{"type":"comment_keyword","keywords":["claude"],"media_ids":["p3"]},
 "steps":[
  {"type":"private_reply","text":"Hej! Kliknij, a wyślę Ci przewodnik.","button":{"title":"Wyślij","payload":"GUIDE"}},
  {"type":"public_reply","variants":["Sprawdź DM 📩","Wysłane!"]},
  {"type":"ask_email","text":"Na jaki email wysłać przewodnik?"},
  {"type":"push_email","provider":"plunk","tags":["claude"]}]}
```

MCP tools: `flow_list`, `flow_get`, `flow_upsert`, `flow_toggle`, `flow_metrics`, `flow_test` (dry run, no side effects). `inbox_overview` gains `auto: {triggered, sent, pending}` (24 h).
REST: `GET /api/flows` · `GET /api/flows/:f` · `POST /api/flows` · `PUT /api/flows/:f` · `POST /api/flows/:f/on|off` · `POST /api/flows/:f/test {text, media?}` · `GET /api/flows/metrics?id=&days=`.
CLI: `sinbox flows list | get f1 | set flow.json | on f1 | off f1 | metrics [f1] [--days 30] | test f1 "Claude!"`.

## Configuration

See [.env.example](.env.example). The main settings:

| Var | Default | |
|---|---|---|
| `SENDING_ENABLED` | `false` | Kill switch for all platform writes |
| `APPROVAL` | `human` | `agent-confirmed` exposes MCP `approve` (needs `confirmedBy` + `ref`) |
| `MAX_SENDS_PER_HOUR` | `30` | |
| `SINBOX_AGENT_KEY` / `SINBOX_ADMIN_KEY` | — | Bootstrap keys (stored as SHA-256). More keys: `sinbox admin key-create` |
| `TOKEN_ENC_KEY` | — | 32 bytes hex/base64; required to connect accounts |
| `META_*` | — | See above |
| `RETENTION_RAW_DAYS` / `RETENTION_TEXT_DAYS` | `30` / `365` | Daily purge job |
| `AUTOMATIONS_ENABLED` / `AUTOMATIONS_AUTOSEND` | `false` / `false` | Rules engine kill switch / self-approval for `mode: "auto"` flows |
| `PLUNK_API_KEY`, `PLUNK_API_URL`, `MAILERLITE_API_KEY`, `MAILERLITE_GROUP_ID` | — | `push_email` providers; off while the key is empty |

## Deploy (Coolify)

- Create a new resource in the existing project, either **Dockerfile** or **Docker Compose** using [`coolify.compose.yaml`](coolify.compose.yaml). Set the domain to `https://inbox.wozu.co`; Traefik and Let's Encrypt are handled by Coolify. The container listens on `8787`.
- Mount a persistent volume at `/data`. Set the env vars in Coolify. Set a memory limit of 192 MB.
- DNS: an A record for `inbox.wozu.co` pointing to the VPS.
- Backups: `sqlite3 /data/inbox.db ".backup /backup/inbox.db"` from the nightly job. This takes an online backup that is consistent while the app runs.
- Create extra keys inside the container: `docker exec -it <ctr> sinbox admin key-create --name grok --scopes read,draft,send`.

## Development

```bash
npm ci
npm run typecheck
npm test            # vitest: fake connector + mocked Graph API fixtures (test/fixtures/meta)
npm run build && node scripts/smoke.mjs
```

The layout follows SPEC §5: `src/core` (store, drafts/approval, compact formatting, triage, windows), `src/mcp`, `src/api`, `src/cli`, `src/connectors/{meta,fake}`, `src/jobs`, `src/web`, `migrations/`.

## License

MIT
