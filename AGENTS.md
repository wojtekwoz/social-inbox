# AGENTS.md

Self-hosted, agent-first inbox for Instagram DMs, comments and mentions: an MCP server plus a compact REST API and a small CLI (`sinbox`). Nothing is sent without human approval. See README.md and SPEC.md for the design.

## Stack

- Node.js >= 22, TypeScript, ESM
- Hono, MCP SDK, better-sqlite3 (SQLite WAL + FTS5), zod, pino
- Vitest for tests; Docker / Coolify for deploys
- Package manager: npm (`package-lock.json`)

## Commands

- Install: `npm ci`
- Dev: `npm run dev`
- Build: `npm run build`
- Start: `npm start`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- CLI: `npm run cli -- <args>`

Local run without credentials: see "Quick start" in README.md (`FAKE_CONNECTOR=true`).

## Working rules

- Work on a branch and open a PR. Never push directly to `main`.
- Never commit secrets or `.env*` files (only `.env.example` with fake values).
- Keep changes small and scoped to the task.
- Never enable real sending (`SENDING_ENABLED=true`) against live accounts while testing.

## Cursor Cloud specific instructions

- Run `npm ci` before anything else.
- Env vars come from Cursor secrets; use `.env.example` for names only.
