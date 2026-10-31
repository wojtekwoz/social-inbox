import { serve } from "@hono/node-server";
import { emailProviders } from "./automations/email.js";
import { loadConfig } from "./config.js";
import { FakeConnector } from "./connectors/fake/index.js";
import { MetaConnector } from "./connectors/meta/index.js";
import { AGENT_SCOPES, Keys, SCOPES } from "./core/auth.js";
import { openDb } from "./core/db.js";
import { Service } from "./core/service.js";
import type { Connector } from "./core/types.js";
import { startScheduler } from "./jobs/scheduler.js";
import { createLogger } from "./log.js";
import { createApp, VERSION } from "./server.js";

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = openDb(config.dbPath);

const keys = new Keys(db);
if (config.agentKey) keys.ensure("agent", config.agentKey, AGENT_SCOPES);
if (config.adminKey) keys.ensure("admin", config.adminKey, SCOPES);
if (!config.agentKey && !config.adminKey && keys.list().length === 0) {
  log.warn("no API keys configured: set SINBOX_AGENT_KEY / SINBOX_ADMIN_KEY or run `sinbox admin key-create`");
}

const connectors: Connector[] = [new MetaConnector(db, config)];
if (config.fakeConnector) {
  const fake = new FakeConnector();
  fake.generate(20);
  connectors.push(fake);
}

const svc = new Service({ db, config, log, connectors, email: emailProviders(config) });
const { app, idle } = createApp(svc);
const stopJobs = startScheduler(svc);

const server = serve({ fetch: app.fetch, port: config.port }, (i) =>
  log.info(
    {
      port: i.port,
      v: VERSION,
      sending: config.sendingEnabled,
      approval: config.approval,
      webhooks: config.meta.webhooksEnabled,
      automations: config.automations.enabled,
      autosend: config.automations.autosend,
    },
    "social-inbox up",
  ),
);

const shutdown = async () => {
  stopJobs();
  server.close();
  await idle();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
