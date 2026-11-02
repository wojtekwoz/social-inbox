#!/usr/bin/env node
// End-to-end smoke test against the built server (npm run build first):
// starts dist/main.js with the fake connector, drives the CLI and the stdio MCP bridge,
// and reports resident memory after warm-up. Usage: node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sinbox-smoke-"));
const port = 18000 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  DB_PATH: join(dir, "inbox.db"),
  PORT: String(port),
  FAKE_CONNECTOR: "true",
  SINBOX_AGENT_KEY: "sk_agent_smoke",
  SINBOX_ADMIN_KEY: "sk_admin_smoke",
  SENDING_ENABLED: "true",
  SEND_MODE: "all",
  POLL_ENABLED: "false",
  LOG_LEVEL: "warn",
  SINBOX_HOME: join(dir, "cli"),
};

const server = spawn(process.execPath, ["--max-old-space-size=96", "dist/main.js"], { env, stdio: ["ignore", "inherit", "inherit"] });
const cli = (key, ...args) => execFileSync(process.execPath, ["dist/cli/index.js", "--url", url, "--key", key, ...args], { env, encoding: "utf8" }).trim();
const rssMb = () => Number(execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)], { encoding: "utf8" }).trim()) / 1024;
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok  ${msg}`);
};

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  check((await fetch(`${url}/healthz`)).ok, "server healthy");

  console.log(cli("sk_agent_smoke", "sync"));
  const ls = cli("sk_agent_smoke", "ls");
  console.log(ls);
  check(ls.split("\n").length > 10, "sinbox ls lists fake items");
  check(cli("sk_agent_smoke", "ls", "--since", "last").startsWith("id"), "sinbox ls --since last works");

  const draft = JSON.parse(cli("sk_agent_smoke", "draft", "i1", "Hej! Minikurs kosztuje 99 zł."));
  check(draft.ok, `draft ${draft.d} created (${draft.checks.join(", ")})`);
  let refused = false;
  try {
    cli("sk_agent_smoke", "approve", draft.d);
  } catch {
    refused = true;
  }
  check(refused, "agent key cannot approve");
  const appr = JSON.parse(cli("sk_admin_smoke", "approve", draft.d, "--send"));
  check(appr.send.st === "sent", "admin approve --send sends");

  // stdio MCP bridge → HTTP /mcp
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli/index.js", "--url", url, "--key", "sk_agent_smoke", "mcp"],
    env,
  });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.includes("inbox_overview"), `stdio bridge lists ${tools.length} tools`);
  const ov = await client.callTool({ name: "inbox_overview", arguments: {} });
  console.log("overview:", ov.content[0].text);
  await client.close();

  // warm up, then measure
  for (let i = 0; i < 200; i++) await fetch(`${url}/api/items?limit=50`, { headers: { authorization: "Bearer sk_agent_smoke" } });
  await new Promise((r) => setTimeout(r, 500));
  const rss = rssMb();
  console.log(`rss after warm-up: ${rss.toFixed(1)} MB`);
  check(rss < 150, "process RSS < 150 MB");
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  rmSync(dir, { recursive: true, force: true });
}
