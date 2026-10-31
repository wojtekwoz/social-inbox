import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { ADMIN_KEY, AGENT_KEY, auth, fakeSetup } from "./helpers.js";

type App = ReturnType<typeof fakeSetup>["app"];

async function mcpClient(app: App, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://local/mcp"), {
    requestInit: { headers: auth(key) },
    fetch: async (url, init) => app.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("REST", () => {
  it("requires a key and keeps public routes public", async () => {
    const { app } = fakeSetup();
    expect((await app.request("/api/overview")).status).toBe(401);
    expect((await app.request("/api/overview", { headers: auth("wrong") })).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/privacy")).status).toBe(200);
    expect((await app.request("/api/overview", { headers: auth(AGENT_KEY) })).status).toBe(200);
  });

  it("agent key can draft and send but not approve; admin key approves", async () => {
    const { app, svc, fake } = fakeSetup();
    fake.generate(2);
    await svc.sync();
    const post = (path: string, key: string, body?: unknown) =>
      app.request(path, { method: "POST", headers: { ...auth(key), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

    const created = await post("/api/drafts", AGENT_KEY, { to: "i1", text: "Hej, minikurs kosztuje 99 zł" });
    expect(created.status).toBe(201);
    const { d } = (await created.json()) as { d: string };

    const send1 = await post(`/api/drafts/${d}/send`, AGENT_KEY);
    expect(send1.status).toBe(409);
    expect(((await send1.json()) as { err: string }).err).toMatch(/not approved/);

    expect((await post(`/api/drafts/${d}/approve`, AGENT_KEY)).status).toBe(403);
    expect((await post(`/api/drafts/${d}/approve`, ADMIN_KEY)).status).toBe(200);

    const send2 = await post(`/api/drafts/${d}/send`, AGENT_KEY);
    expect(await send2.json()).toMatchObject({ d, st: "sent" });
    expect(fake.sent).toHaveLength(1);
  });

  it("parses list query strings and validates input", async () => {
    const { app, svc, fake } = fakeSetup();
    fake.generate(10);
    await svc.sync();
    const r = await app.request("/api/items?src=ig.dm,ig.mn&limit=3&fmt=lines", { headers: auth(AGENT_KEY) });
    const body = (await r.json()) as { lines: string; more: boolean };
    expect(body.lines.split("\n")).toHaveLength(4);
    expect(body.more).toBe(true);
    const bad = await app.request("/api/items?src=xx.yy", { headers: auth(AGENT_KEY) });
    expect(bad.status).toBe(400);
  });
});

describe("MCP over Streamable HTTP", () => {
  it("lists v1 tools without approve in human mode, and runs a delta round-trip", async () => {
    const { app, svc, fake, clock } = fakeSetup();
    fake.generate(3);
    await svc.sync();
    const client = await mcpClient(app, AGENT_KEY);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "draft_moderation", "draft_reply", "drafts", "inbox_list", "inbox_overview", "item_get", "mark", "search", "send_approved", "sync_now", "thread_get", "thread_note",
        "flow_list", "flow_get", "flow_upsert", "flow_toggle", "flow_metrics", "flow_test",
      ].sort(),
    );

    const ov = json(await client.callTool({ name: "inbox_overview", arguments: {} }));
    expect(ov.unread).toEqual({ "ig.dm": 2, "ig.cm": 1 });
    const l1 = json(await client.callTool({ name: "inbox_list", arguments: {} }));
    expect(l1.rows).toHaveLength(3);

    clock.t += 60_000;
    fake.generate(1, 1000);
    await svc.sync({ force: true });
    const l2 = json(await client.callTool({ name: "inbox_list", arguments: { since: l1.next } }));
    expect(l2.rows).toHaveLength(1);

    const draft = json(await client.callTool({ name: "draft_reply", arguments: { to: "i1", text: "Cześć!" } }));
    expect(draft).toMatchObject({ ok: true, checks: [expect.stringMatching(/^win /), "len 6/1000"] });
    const send = await client.callTool({ name: "send_approved", arguments: { d: draft.d } });
    expect(send.isError).toBe(true);
    expect(json(send).err).toMatch(/not approved/);
    await client.close();
  });

  it("exposes approve only with APPROVAL=agent-confirmed, and audits the confirmation", async () => {
    const { app, svc, fake } = fakeSetup({ APPROVAL: "agent-confirmed" });
    fake.generate(1);
    await svc.sync();
    const client = await mcpClient(app, AGENT_KEY);
    expect((await client.listTools()).tools.some((t) => t.name === "approve")).toBe(true);
    const { d } = json(await client.callTool({ name: "draft_reply", arguments: { to: "i1", text: "ok" } }));
    const r = json(await client.callTool({ name: "approve", arguments: { d, confirmedBy: "wozu", ref: "grok:msg:123" } }));
    expect(r.st).toBe("approved");
    const audit = svc.db.prepare("SELECT detail FROM audit WHERE action = 'approve'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toEqual({ by: "wozu", ref: "grok:msg:123" });
    await client.close();
  });

  it("rejects MCP calls without a valid key", async () => {
    const { app } = fakeSetup();
    const r = await app.request("/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
  });
});
