// Runtime configuration from environment variables. See .env.example.

export type Approval = "human" | "agent-confirmed";
/** Who approved drafts may reach: nobody, only SEND_ALLOWLIST recipients, or everyone. */
export type SendMode = "off" | "testers" | "all";
const SEND_MODES: SendMode[] = ["off", "testers", "all"];

export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  logLevel: string;
  /** Kill switch: approved drafts are only executed against platform APIs when true. */
  sendingEnabled: boolean;
  /** Second gate on top of SENDING_ENABLED. Default "off": nothing is sent. */
  sendMode: SendMode;
  /** SEND_ALLOWLIST: IGSIDs and/or usernames, lowercased, without a leading "@". */
  sendAllowlist: string[];
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
  automations: {
    /** Global kill switch: when false the engine evaluates nothing. */
    enabled: boolean;
    /** Lets `mode: "auto"` flows approve their own drafts (still gated by SENDING_ENABLED). */
    autosend: boolean;
    /** One automated message per contact per flow step within this many hours. */
    cooldownHours: number;
  };
  email: {
    plunkApiKey?: string;
    plunkApiUrl: string;
    mailerliteApiKey?: string;
    mailerliteGroupId?: string;
    mailerliteApiUrl: string;
  };
}

const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

/** "@Tester_One " → "tester_one"; IGSIDs pass through unchanged. */
export const normRecipient = (v: string) => v.trim().replace(/^@/, "").toLowerCase();

/** True when approved drafts may be executed at all (SENDING_ENABLED=true and SEND_MODE != off). */
export const sendingOn = (cfg: Config) => cfg.sendingEnabled && cfg.sendMode !== "off";

/** SEND_MODE=all lets everyone through; testers needs one of the recipient's ids/usernames on SEND_ALLOWLIST. */
export function recipientAllowed(cfg: Config, ...ids: (string | null | undefined)[]): boolean {
  if (cfg.sendMode === "all") return true;
  if (cfg.sendMode === "off") return false;
  return ids.some((id) => !!id && cfg.sendAllowlist.includes(normRecipient(id)));
}

/** Compact label for inbox_overview: "off", "testers(2)" or "all". */
export const sendLabel = (cfg: Config) =>
  !sendingOn(cfg) ? "off" : cfg.sendMode === "testers" ? `testers(${cfg.sendAllowlist.length})` : "all";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const approval = (env.APPROVAL ?? "human") as Approval;
  if (approval !== "human" && approval !== "agent-confirmed") {
    throw new Error(`APPROVAL must be "human" or "agent-confirmed", got "${approval}"`);
  }
  const sendMode = (env.SEND_MODE || "off").toLowerCase() as SendMode;
  if (!SEND_MODES.includes(sendMode)) throw new Error(`SEND_MODE must be one of ${SEND_MODES.join(", ")}, got "${env.SEND_MODE}"`);
  const graphVersion = env.META_GRAPH_VERSION ?? "v24.0";
  return {
    port: num(env.PORT, 8787),
    publicUrl: (env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    dbPath: env.DB_PATH ?? "./data/inbox.db",
    logLevel: env.LOG_LEVEL ?? "info",
    sendingEnabled: bool(env.SENDING_ENABLED, false),
    sendMode,
    sendAllowlist: [...new Set((env.SEND_ALLOWLIST ?? "").split(",").map(normRecipient).filter(Boolean))],
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
    automations: {
      enabled: bool(env.AUTOMATIONS_ENABLED, false),
      autosend: bool(env.AUTOMATIONS_AUTOSEND, false),
      cooldownHours: num(env.AUTOMATIONS_COOLDOWN_HOURS, 24),
    },
    email: {
      plunkApiKey: env.PLUNK_API_KEY || undefined,
      plunkApiUrl: (env.PLUNK_API_URL || "https://api.useplunk.com").replace(/\/$/, ""),
      mailerliteApiKey: env.MAILERLITE_API_KEY || undefined,
      mailerliteGroupId: env.MAILERLITE_GROUP_ID || undefined,
      mailerliteApiUrl: (env.MAILERLITE_API_URL || "https://connect.mailerlite.com").replace(/\/$/, ""),
    },
  };
}
