// Runtime configuration from environment variables. See .env.example.

export type Approval = "human" | "agent-confirmed";

export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  logLevel: string;
  /** Kill switch: approved drafts are only executed against platform APIs when true. */
  sendingEnabled: boolean;
  approval: Approval;
  maxSendsPerHour: number;
  /** Bootstrap API keys (hashed in memory, never stored in plain text). */
  agentKey?: string;
  adminKey?: string;
  tokenEncKey?: string;
  pollEnabled: boolean;
  fakeConnector: boolean;
  retentionRawDays: number;
  retentionTextDays: number;
  meta: {
    appId?: string;
    appSecret?: string;
    configId?: string;
    graphVersion: string;
    graphBase: string;
    webhooksEnabled: boolean;
    webhookVerifyToken?: string;
    humanAgent: boolean;
    pageId?: string;
    backfillDays: number;
  };
}

const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const approval = (env.APPROVAL ?? "human") as Approval;
  if (approval !== "human" && approval !== "agent-confirmed") {
    throw new Error(`APPROVAL must be "human" or "agent-confirmed", got "${approval}"`);
  }
  const graphVersion = env.META_GRAPH_VERSION ?? "v24.0";
  return {
    port: num(env.PORT, 8787),
    publicUrl: (env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    dbPath: env.DB_PATH ?? "./data/inbox.db",
    logLevel: env.LOG_LEVEL ?? "info",
    sendingEnabled: bool(env.SENDING_ENABLED, false),
    approval,
    maxSendsPerHour: num(env.MAX_SENDS_PER_HOUR, 30),
    agentKey: env.SINBOX_AGENT_KEY || undefined,
    adminKey: env.SINBOX_ADMIN_KEY || undefined,
    tokenEncKey: env.TOKEN_ENC_KEY || undefined,
    pollEnabled: bool(env.POLL_ENABLED, true),
    fakeConnector: bool(env.FAKE_CONNECTOR, false),
    retentionRawDays: num(env.RETENTION_RAW_DAYS, 30),
    retentionTextDays: num(env.RETENTION_TEXT_DAYS, 365),
    meta: {
      appId: env.META_APP_ID || undefined,
      appSecret: env.META_APP_SECRET || undefined,
      configId: env.META_LOGIN_CONFIG_ID || undefined,
      graphVersion,
      graphBase: env.META_GRAPH_BASE ?? "https://graph.facebook.com",
      webhooksEnabled: bool(env.META_WEBHOOKS_ENABLED, false),
      webhookVerifyToken: env.WEBHOOK_VERIFY_TOKEN || undefined,
      humanAgent: bool(env.META_HUMAN_AGENT, false),
      pageId: env.META_PAGE_ID || undefined,
      backfillDays: num(env.META_BACKFILL_DAYS, 30),
    },
  };
}
