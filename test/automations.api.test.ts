import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compact.js";
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

const flow = {
  name: "Claude guide",
  trigger: { type: "comment_keyword", keywords: ["claude"] },
  steps: [
    { type: "private_reply", text: "Kliknij po przewodnik", button: { title: "Wyślij", payload: "GUIDE" } },
    { type: "public_reply", variants: ["Sprawdź DM"] },
  ],
};

describe("flow tools over MCP", () => {
  it("upsert → list → get → toggle → test → metrics, with compact columnar output", async () => {
    const { app, db } = fakeSetup({ AUTOMATIONS_ENABLED: "true" });
    const c = await mcpClient(app, AGENT_KEY);

    const up = json(await c.callTool({ name: "flow_upsert", arguments: flow }));
    expect(up).toEqual({ f: "f1", ok: true, on: 0, mode: "draft", created: true });

    expect(json(await c.callTool({ name: "flow_toggle", arguments: { id: "f1", on: true } }))).toEqual({ f: "f1", on: 1 });
    const list = json(await c.callTool({ name: "flow_list", arguments: {} }));
    expect(list).toEqual({ cols: ["f", "name", "on", "mode", "trig", "n7", "s7"], rows: [["f1", "Claude guide", 1, "draft", "cm:claude", 0, 0]] });
    expect(estimateTokens(list)).toBeLessThan(60);

    const got = json(await c.callTool({ name: "flow_get", arguments: { id: "f1" } }));
    expect(got).toMatchObject({ f: "f1", on: 1, trigger: flow.trigger, steps: flow.steps });

    const hit = json(await c.callTool({ name: "flow_test", arguments: { id: "f1", text: "CLAUDE 🔥" } }));
    expect(hit).toEqual({ f: "f1", m: 1, norm: "claude", kw: "claude", steps: ["private_reply", "public_reply"], would: "draft" });
    const miss = json(await c.callTool({ name: "flow_test", arguments: { id: "f1", text: "super odcinek" } }));
    expect(miss).toMatchObject({ m: 0 });
    // dry run: no runs, events, drafts or ledger rows
    for (const t of ["flow_runs", "flow_events", "drafts", "flow_seen"]) expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });

    const m = json(await c.callTool({ name: "flow_metrics", arguments: { id: "f1" } }));
    expect(m).toMatchObject({ days: 7, cols: ["f", "name", "trig", "draft", "sent", "pub", "tap", "qr", "email", "push", "skip", "fail"], rows: [["f1", "Claude guide", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] });
  });

  it("rejects policy violations and keeps mode:auto for approve-scoped keys only", async () => {
    const { app } = fakeSetup({ AUTOMATIONS_ENABLED: "true" });
    const agent = await mcpClient(app, AGENT_KEY);
    const gated = await agent.callTool({ name: "flow_upsert", arguments: { ...flow, trigger: { ...flow.trigger, followers_only: true } } });
    expect(gated.isError).toBe(true);
    expect(json(gated).err).toMatch(/follow-gating/);

    const auto = await agent.callTool({ name: "flow_upsert", arguments: { ...flow, mode: "auto" } });
    expect(auto.isError).toBe(true);
    expect(json(auto).err).toMatch(/approve-scoped key/);

    const admin = await mcpClient(app, ADMIN_KEY);
    expect(json(await admin.callTool({ name: "flow_upsert", arguments: { ...flow, mode: "auto" } }))).toMatchObject({ f: "f1", mode: "auto" });
    // the agent may not switch it on or edit it while it stays auto, but may downgrade it to draft
    expect((await agent.callTool({ name: "flow_toggle", arguments: { id: "f1", on: true } })).isError).toBe(true);
    expect((await agent.callTool({ name: "flow_upsert", arguments: { ...flow, id: "f1", name: "renamed" } })).isError).toBe(true);
    expect(json(await agent.callTool({ name: "flow_upsert", arguments: { ...flow, id: "f1", mode: "draft" } }))).toMatchObject({ mode: "draft" });
    expect(json(await agent.callTool({ name: "flow_toggle", arguments: { id: "f1", on: false } }))).toEqual({ f: "f1", on: 0 });
  });

  it("inbox_overview gains auto counts; drafts list shows the run", async () => {
    const { app, svc } = fakeSetup({ AUTOMATIONS_ENABLED: "true" });
    svc.flows.upsert({ ...flow, enabled: true }, "test", true);
    await svc.ingest([{ net: "fake", nativeId: "c1", src: "ig.cm", threadNativeId: "c1", authorId: "u1", text: "claude", ts: svc.now() - 60_000, post: { nativeId: "m1" } }]);
    const c = await mcpClient(app, AGENT_KEY);
    expect(json(await c.callTool({ name: "inbox_overview", arguments: {} })).auto).toEqual({ triggered: 1, sent: 0, pending: 2 });
    const drafts = json(await c.callTool({ name: "drafts", arguments: {} }));
    expect(drafts.cols).toContain("auto");
    expect(drafts.rows.every((r: unknown[]) => r[drafts.cols.indexOf("auto")] === "r1")).toBe(true);
  });
});

describe("flow REST routes", () => {
  it("mirrors the tools", async () => {
    const { app } = fakeSetup({ AUTOMATIONS_ENABLED: "true" });
    const req = (method: string, path: string, key = AGENT_KEY, body?: unknown) =>
      app.request(path, { method, headers: { ...auth(key), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

    const created = await req("POST", "/api/flows", AGENT_KEY, flow);
    expect(created.status).toBe(201);
    expect((await req("POST", "/api/flows/f1/on")).status).toBe(200);
    expect(((await (await req("GET", "/api/flows")).json()) as { rows: unknown[] }).rows).toHaveLength(1);
    expect(await (await req("GET", "/api/flows/f1")).json()).toMatchObject({ f: "f1", on: 1 });
    expect(await (await req("POST", "/api/flows/f1/test", AGENT_KEY, { text: "Claude?" })).json()).toMatchObject({ m: 1 });
    expect(await (await req("GET", "/api/flows/metrics?id=f1&days=30")).json()).toMatchObject({ days: 30 });
    const upd = await req("PUT", "/api/flows/f1", AGENT_KEY, { ...flow, name: "v2" });
    expect(await upd.json()).toMatchObject({ f: "f1", ok: true });
    expect((await req("POST", "/api/flows/f1/off")).status).toBe(200);

    const bad = await req("POST", "/api/flows", AGENT_KEY, { ...flow, steps: [{ type: "send_dm", text: "x", require_follow: true }] });
    expect(bad.status).toBe(422);
    expect((await req("PUT", "/api/flows/f1", AGENT_KEY, { ...flow, mode: "auto" })).status).toBe(403);
    expect((await req("PUT", "/api/flows/f1", ADMIN_KEY, { ...flow, mode: "auto" })).status).toBe(200);
    expect((await req("GET", "/api/flows/f9")).status).toBe(404);
    expect((await app.request("/api/flows")).status).toBe(401);
  });
});
