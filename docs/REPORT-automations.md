# M5 Automations engine: build report

Branch `feat/automations-engine` · 31 Oct 2026 · Spec: [SPEC-automations.md](SPEC-automations.md)

## Status

| Check | Result |
|---|---|
| `npm test` | ✅ **101 passed** (49 existing + 52 new) in 8 files |
| `npm run typecheck` | ⚠️ **not run.** The agent session's permission settings blocked `tsc`. The code was type-reviewed by hand, but this has to be run before merging |
| `npm run build` | ⚠️ **not run** (also `tsc`, also blocked) |
| Commits | ⚠️ **none.** `git add` / `git commit` were blocked too, so everything is uncommitted in the working tree |

One existing test changed: `test/http.test.ts` now also expects the six new `flow_*` MCP tools in the tool list. No other existing test was touched.

## What was built

New code lives in `src/automations/` (small focused files):

| File | Role |
|---|---|
| `match.ts` | Normaliser (lowercase, NFD diacritics + `ł`/`ø`/`ß`…, punctuation/emoji → space), `exact`/`word`/`contains` matching, whole-message opt-out detection, email validation/extraction |
| `schema.ts` | Zod flow schema + `validateFlow`, which enforces the policy: follow-gating, Meta limits, step ordering |
| `triggers.ts` | Classifies inbound items (comment, DM, postback/quick reply, story reply/mention) from webhook or poll raw payloads; matches triggers |
| `store.ts` | SQL for flows, runs, events, opt-outs and the evaluation ledger |
| `engine.ts` | `Automations`: evaluates each new item once (serialised), runs steps, applies the send policy, creates drafts through `Service.createDraft`, auto-approves/sends only when allowed, and records `sent` events from the send path |
| `email.ts` | `EmailProvider` + Plunk and MailerLite adapters (injectable fetch) + `FakeEmailProvider` |
| `metrics.ts` | `flow_metrics` aggregation and the 7-day counts used by `flow_list` |
| `api.ts` | `FlowApi` (list/get/upsert/toggle/metrics/test), shared by MCP, REST and CLI |

Changes elsewhere:

- `migrations/002_automations.sql` creates `flows`, `flow_runs`, `flow_events`, `contacts_optout` and `flow_seen`, and adds `drafts.flow_run_id` + `drafts.payload`. The existing runner applies it automatically.
- `Service.ingest()` is now the single path for both polling and webhooks: store (deduped) → evaluate new ids. `Store.ingest` now actually fills `ids`.
- `Service.createDraft()` (`draftReply` delegates to it) takes an optional `payload` and `flowRunId`. For automation drafts, HUMAN_AGENT is disabled at draft, edit, approve and send.
- Meta connector: `igMessage()` builds a button template or quick replies from `drafts.payload` for DMs and private replies. The webhook parser handles `messaging_postbacks`, `message.quick_reply.payload`, `message.reply_to.story` and `story_mention` attachments, normalised to the poller's `raw.story` shape. The poller already stored `story` in raw; a test covers it. HMAC verification is unchanged.
- MCP: `flow_list`, `flow_get`, `flow_upsert`, `flow_toggle`, `flow_metrics`, `flow_test`. REST: `/api/flows…`. CLI: `sinbox flows list|get|set|on|off|metrics|test`. `inbox_overview.auto = {triggered, sent, pending}`. The `drafts` list has an `auto` column (run id).
- Config: `AUTOMATIONS_ENABLED`, `AUTOMATIONS_AUTOSEND`, `AUTOMATIONS_COOLDOWN_HOURS`, `PLUNK_API_KEY`, `PLUNK_API_URL`, `MAILERLITE_API_KEY`, `MAILERLITE_GROUP_ID` (+ optional `MAILERLITE_API_URL`). `.env.example`, README (Automations section), CHANGELOG and SPEC §9 are updated.
- `forgetPerson` (Meta data deletion) also deletes the person's flow runs, which hold captured emails. Opt-outs are kept.

### How a flow runs
A trigger creates a run (`UNIQUE(flow_id, item_id)`) plus a `triggered` event, then executes steps in order. A step with a postback button or quick replies *arms* the run. Non-DM steps (e.g. `public_reply`, `tag`) keep going, but the first step that needs the 24 h window waits (`waiting_input`) until the matching tap arrives. `ask_email` waits for the next DM: a valid email continues the run, the first invalid reply gets one retry message, and the second stops the run. Every message is a `pending` draft created by `system:automation` with idempotency key `auto:<run>:<step>`.

## Acceptance criteria (§10) and how each is tested

| # | Criterion | Tests |
|---|---|---|
| 1 | "Claude!" (case/diacritics-insensitive) on a configured reel → exactly one private-reply draft with one button; same comment id / poll+webhook duplicate → nothing; comment > 7 days → skipped with reason | `automations.engine.test.ts` › *acceptance 1* (3 tests: "CLAUDÉ!!" → 1 private reply with `payload.buttons.length = 1`; re-ingest, edited re-ingest and a forced re-evaluation create nothing; 8-day-old comment → `skipped/comment_too_old`). `automations.meta.test.ts` › *end to end*: a real webhook fixture, the same comment redelivered by webhook **and** returned by the mocked Graph poller → still one draft |
| 2 | Button-tap postback within 24 h advances to `ask_email`; a valid email is pushed to the fake Plunk/MailerLite adapter and recorded; outside 24 h → skipped with reason | *acceptance 2* (4 tests: tap → ask_email draft + `button_tap`; email → `FakeEmailProvider.pushed`, `email_captured`, `email_pushed`, run `done`; late tap (26 h) → `skipped/window_closed`, run stopped; invalid email → one retry then `invalid_email`; provider missing → `email_off`, sending off → `sending_off`). Meta e2e: a `messaging_postbacks` webhook → ask_email → email webhook → pushed |
| 3 | Defaults → nothing reaches `send`; with all switches on, a `mode:auto` flow sends via the fake connector only | *acceptance 3* (4 tests: defaults → all `pending`, `fake.sent` empty; AUTOSEND without SENDING → `approved` by `system:automation`, not sent; all on → `fake.sent` = private_reply + reply, while a draft-mode flow stays pending; HUMAN_AGENT never used for automation DMs). Meta e2e checks the Graph body uses `messaging_type: RESPONSE` with `META_HUMAN_AGENT=true` |
| 4 | `flow_metrics` correct; `flow_upsert` rejects follow-gating; unmatched DMs stay untouched | *acceptance 4* (exact metrics row, `why`, `conv`, per-media rows; follow-gated upsert → error and no row; unmatched DM + comment → no label, unread, no drafts/events/runs). `automations.unit.test.ts` covers four follow-gating shapes plus a follow trigger. `automations.api.test.ts` checks the same through MCP and REST (422) |

Other coverage: opt-out (stops runs, blocks later triggers, opt-out message stays visible), cooldown, `MAX_SENDS_PER_HOUR`, one private reply even if a human drafted one, round-robin variants, the engine kill switch, quick-reply continuation, story reply/mention/ice-breaker triggers (fake + webhook + poll), priority ordering, `soft_follow_ask` non-blocking, `handoff`, editing a flow stops its runs, data deletion, overview counts, scope gating for `auto` flows, `flow_test` having no side effects, the Graph message formats, and the email adapters' request shape and error handling without network.

### Test counts

| File | Tests |
|---|---|
| `automations.engine.test.ts` | 27 |
| `automations.unit.test.ts` | 10 |
| `automations.meta.test.ts` | 6 |
| `automations.email.test.ts` | 5 |
| `automations.api.test.ts` | 4 |
| existing (`core`, `meta`, `http`) | 49 |
| **total** | **101** |

There are no real network calls. Graph goes through `graphMock`, email adapters use a recording fetch, and all keys and secrets are obviously fake (`test_plunk_key`, …).

## Deferred

From the brief/spec: ice breaker / persistent menu publishing (`messenger_profile`), follow check (`is_user_follow_business`, so `soft_follow_ask` is currently always a no-op), click-tracking redirect, 23 h reminders, A/B testing beyond round-robin, the 700/h private-reply limiter, Meta App Review.

Also deferred during the build (added to SPEC §9): live verification of the IG button template on private replies and of quick-reply payloads (polling doesn't request them, so quick-reply taps are only recognised via webhooks), flow deletion (flows can only be switched off), a job that closes stale waiting runs (they are just ignored after their wait window), and mentions (`ig.mn`) as triggers.

## Decisions for wozu

1. **Cooldown default.** The spec says "one automated message per contact per flow step". I read that as within `AUTOMATIONS_COOLDOWN_HOURS` (default **24 h**). A second "claude" comment from the same person within 24 h gets no second private reply (`skipped/cooldown`). Should it be longer, or permanent per flow?
2. **`push_email` needs `SENDING_ENABLED=true`.** I treated it as an external write under the same kill switch, so with sending off a captured email stays in the run (`skipped/sending_off`) and isn't pushed. It does *not* need draft approval, because the person typed it in themselves. OK?
3. **Who may run `auto` flows.** Creating, editing or switching on a `mode: "auto"` flow needs an `approve`-scoped key, so the default agent key can't create self-approving flows. Agents can still downgrade one to `draft` or switch it off.
4. **Backfill safety.** Items older than the moment a flow was switched on (minus 15 min of poll lag) never trigger it (`skipped/before_flow`). This prevents a burst of replies on first connect or after downtime. OK, or should flows act on recent history?
5. **Opt-out matching** uses the whole message only ("STOP", "nie pisz!"), not any word ("can't stop watching" doesn't unsubscribe). Add more keywords (e.g. "wypisz")?
6. **Waiting for an email consumes the next DM.** Per the spec, a non-email reply (e.g. a question) gets one retry prompt. The item stays unread in the inbox, but the retry still goes into the queue. Would you rather leave non-email replies alone?
7. **Plunk endpoint.** The adapter uses `POST /v1/track` (event `instagram-lead`, or the step's `event`) so Plunk automations can fire. `PLUNK_API_URL` points at your self-hosted Plunk. Please check it against your Plunk version. MailerLite ignores `tags` (groups only).
8. **Contact id for comments.** Runs link a comment's `from.id` to the IGSID in the later postback/DM. This holds for the Instagram API, but please confirm it once live with a tester account.
