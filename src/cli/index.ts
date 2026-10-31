#!/usr/bin/env node
import { Command } from "commander";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `sinbox`: thin client over the REST API, a stdio MCP bridge, and local admin commands.

const DIR = process.env.SINBOX_HOME ?? join(homedir(), ".config", "sinbox");
const STATE = join(DIR, "state.json");
const CONF = join(DIR, "config.json");

const readJson = (p: string): Record<string, string> => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const writeJson = (p: string, v: unknown) => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
};

const program = new Command().name("sinbox").description("Social Inbox CLI").version("0.1.0");
program.option("--url <url>", "server URL (env SINBOX_URL)").option("--key <key>", "API key (env SINBOX_KEY)");

function conn() {
  const o = program.opts<{ url?: string; key?: string }>();
  const c = readJson(CONF);
  const url = (o.url ?? process.env.SINBOX_URL ?? c.url ?? "http://localhost:8787").replace(/\/$/, "");
  const key = o.key ?? process.env.SINBOX_KEY ?? c.key;
  if (!key) fail("no API key: pass --key, set SINBOX_KEY, or run `sinbox login`");
  return { url, key: key! };
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const { url, key } = conn();
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) fail(String(json.err ?? res.statusText));
  return json;
}

const out = (v: unknown): void => void process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n");
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

program
  .command("login")
  .description("save server URL and API key to ~/.config/sinbox/config.json (0600)")
  .argument("<url>")
  .argument("<key>")
  .action((url: string, key: string) => {
    writeJson(CONF, { url, key });
    out(`saved ${CONF}`);
  });

program.command("overview").alias("ov").action(async () => out(await call("GET", "/api/overview")));

program
  .command("ls")
  .description("list items (unread by default)")
  .option("--since <cursor>", '"last" = cursor saved by the previous ls')
  .option("--all", "include read items")
  .option("--src <src>", "ig.dm,ig.cm,ig.mn")
  .option("--lbl <labels>")
  .option("--limit <n>")
  .option("--json")
  .action(async (o: { since?: string; all?: boolean; src?: string; lbl?: string; limit?: string; json?: boolean }) => {
    const state = readJson(STATE);
    const since = o.since === "last" ? state.cursor : o.since;
    const r = await call("GET", "/api/items" + qs({ since, unread: o.all ? "0" : undefined, src: o.src, lbl: o.lbl, limit: o.limit, fmt: o.json ? undefined : "lines" }));
    writeJson(STATE, { ...state, cursor: r.next });
    if (o.json) return out(r);
    out(String(r.lines));
    out(`next=${r.next}${r.more ? " more" : ""}${r.unread_left ? ` unread_left=${r.unread_left}` : ""}`);
  });

program
  .command("thread")
  .argument("<t>")
  .option("--last <n>")
  .action(async (t: string, o: { last?: string }) => out(await call("GET", `/api/threads/${t}` + qs({ last: o.last }))));
program
  .command("item")
  .argument("<id>")
  .option("--full")
  .action(async (id: string, o: { full?: boolean }) => out(await call("GET", `/api/items/${id}` + qs({ full: o.full ? 1 : undefined }))));
program.command("search").argument("<q>").action(async (q: string) => out(await call("GET", "/api/search" + qs({ q }))));
program
  .command("mark")
  .argument("<ids...>", "item/thread ids")
  .option("--unread")
  .action(async (ids: string[], o: { unread?: boolean }) => out(await call("POST", "/api/mark", { ids, read: !o.unread })));
program
  .command("note")
  .argument("<t>")
  .argument("<summary>")
  .action(async (t: string, summary: string) => out(await call("PUT", `/api/threads/${t}/note`, { summary })));

program
  .command("drafts")
  .option("--status <s>")
  .action(async (o: { status?: string }) => out(await call("GET", "/api/drafts" + qs({ status: o.status }))));
program.command("show").argument("<d>").action(async (d: string) => out(await call("GET", `/api/drafts/${d}`)));
program
  .command("draft")
  .description("create a reply/DM draft")
  .argument("<to>", "item or thread id")
  .argument("<text>")
  .option("--kind <k>", "reply|dm|private_reply")
  .action(async (to: string, text: string, o: { kind?: string }) => out(await call("POST", "/api/drafts", { to, text, kind: o.kind })));
program
  .command("moderate")
  .argument("<id>")
  .argument("<action>", "hide|unhide|delete")
  .action(async (id: string, action: string) => out(await call("POST", "/api/drafts/moderation", { id, action })));
program
  .command("edit")
  .argument("<d>")
  .argument("<text>")
  .action(async (d: string, text: string) => out(await call("PATCH", `/api/drafts/${d}`, { text })));
program
  .command("approve")
  .description("approve a draft (needs a key with the approve scope)")
  .argument("<d>")
  .option("--send", "send right after approving")
  .action(async (d: string, o: { send?: boolean }) => out(await call("POST", `/api/drafts/${d}/approve` + qs({ send: o.send ? 1 : undefined }))));
program.command("reject").argument("<d>").action(async (d: string) => out(await call("POST", `/api/drafts/${d}/reject`)));
program.command("send").argument("<d>").action(async (d: string) => out(await call("POST", `/api/drafts/${d}/send`)));
program
  .command("sync")
  .argument("[src]")
  .action(async (src?: string) => out(await call("POST", "/api/sync", src ? { src } : {})));
program
  .command("connect")
  .argument("<net>", "meta")
  .description("print the OAuth login URL; open it in a browser")
  .action(async (net: string) => {
    if (net !== "meta") fail("only `meta` is supported");
    out((await call("POST", "/api/oauth/meta/start")).url);
  });

program
  .command("mcp")
  .description("stdio MCP bridge to the server's /mcp endpoint (for local MCP clients)")
  .action(async () => {
    const { url, key } = conn();
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const stdio = new StdioServerTransport();
    const http = new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
    stdio.onmessage = (m) => void http.send(m).catch((e) => process.stderr.write(`mcp bridge: ${(e as Error).message}\n`));
    http.onmessage = (m) => void stdio.send(m);
    http.onerror = (e) => process.stderr.write(`mcp bridge: ${e.message}\n`);
    stdio.onclose = () => void http.close().then(() => process.exit(0));
    await http.start();
    await stdio.start();
  });

// ---- admin: runs against the local database (inside the container: `node dist/cli/index.js admin …`)
const admin = program.command("admin").description("local admin commands (need DB_PATH)");
async function local() {
  const { openDb } = await import("../core/db.js");
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();
  return { db: openDb(cfg.dbPath), cfg };
}
admin
  .command("key-create")
  .requiredOption("--name <name>")
  .option("--scopes <scopes>", "read,draft,send,approve", "read,draft,send")
  .action(async (o: { name: string; scopes: string }) => {
    const { Keys, parseScopes } = await import("../core/auth.js");
    const { db } = await local();
    out(new Keys(db).create(o.name, parseScopes(o.scopes)));
    process.stderr.write("store this key now; it is not shown again\n");
  });
admin.command("key-list").action(async () => {
  const { Keys } = await import("../core/auth.js");
  out(new Keys((await local()).db).list());
});
admin
  .command("key-revoke")
  .argument("<name>")
  .action(async (name: string) => {
    const { Keys } = await import("../core/auth.js");
    out({ revoked: new Keys((await local()).db).revoke(name) });
  });
admin
  .command("export")
  .description("export everything stored about a person (native user id, e.g. IGSID)")
  .argument("<uid>")
  .action(async (uid: string) => {
    const { Store } = await import("../core/store.js");
    out(new Store((await local()).db).exportPerson("ig", uid));
  });
admin
  .command("forget")
  .description("delete everything stored about a person (native user id)")
  .argument("<uid>")
  .action(async (uid: string) => {
    const { Store } = await import("../core/store.js");
    const s = new Store((await local()).db);
    const n = s.forgetPerson("ig", uid);
    s.audit("cli", "forget", undefined, { n });
    out({ deleted: n });
  });
admin
  .command("rotate-key")
  .description("re-encrypt stored OAuth tokens with a new TOKEN_ENC_KEY")
  .requiredOption("--old <key>")
  .requiredOption("--new <key>")
  .action(async (o: { old: string; new: string }) => {
    const { rotateKey } = await import("../connectors/meta/account.js");
    out({ rotated: rotateKey((await local()).db, o.old, o.new) });
  });
admin.command("migrate").action(async () => {
  await local();
  out("ok");
});

program.parseAsync().catch((e) => fail((e as Error).message));
