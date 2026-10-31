import { randomBytes } from "node:crypto";
import type { Config } from "../../config.js";
import type { DB } from "../../core/db.js";
import { UserError } from "../../core/errors.js";
import { saveAccount, type IgAccount } from "./account.js";
import type { Graph } from "./graph.js";

// Facebook Login for Business (Instagram API with Facebook Login). We request only what §2.1 lists;
// when META_LOGIN_CONFIG_ID is set, the permissions come from that Login configuration instead.

export const META_SCOPES = [
  "instagram_basic",
  "instagram_manage_messages",
  "instagram_manage_comments",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  // Meta lists business_management as a dependency of instagram_manage_messages under Facebook Login for Business.
  "business_management",
];

const STATE_TTL_MS = 10 * 60_000;

export const redirectUri = (cfg: Config) => `${cfg.publicUrl}/oauth/meta/callback`;

export function loginUrl(db: DB, cfg: Config): string {
  if (!cfg.meta.appId) throw new UserError("META_APP_ID is not set", 409);
  const state = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO oauth_states (state, net, expires_at) VALUES (?, 'meta', ?)").run(state, Date.now() + STATE_TTL_MS);
  const u = new URL(`https://www.facebook.com/${cfg.meta.graphVersion}/dialog/oauth`);
  u.searchParams.set("client_id", cfg.meta.appId);
  u.searchParams.set("redirect_uri", redirectUri(cfg));
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  if (cfg.meta.configId) {
    u.searchParams.set("config_id", cfg.meta.configId);
    u.searchParams.set("override_default_response_type", "true");
  } else {
    u.searchParams.set("scope", META_SCOPES.join(","));
  }
  return u.toString();
}

/** Single-use, time-limited state check. */
export function consumeState(db: DB, state: string | undefined): boolean {
  if (!state) return false;
  const r = db.prepare("DELETE FROM oauth_states WHERE state = ? AND net = 'meta' AND expires_at > ?").run(state, Date.now());
  return r.changes === 1;
}

interface PageAcct {
  id: string;
  name?: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

/** code → short user token → long-lived user token → Page token (non-expiring) + linked IG account. */
export async function completeLogin(db: DB, cfg: Config, graph: Graph, code: string): Promise<IgAccount> {
  if (!cfg.meta.appId || !cfg.meta.appSecret) throw new UserError("META_APP_ID / META_APP_SECRET not set", 409);
  if (!cfg.tokenEncKey) throw new UserError("TOKEN_ENC_KEY not set; refusing to store tokens unencrypted", 409);
  const short = await graph.get<{ access_token: string }>(
    "oauth/access_token",
    { client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, redirect_uri: redirectUri(cfg), code },
    "",
  );
  const long = await graph.get<{ access_token: string; expires_in?: number }>(
    "oauth/access_token",
    { grant_type: "fb_exchange_token", client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, fb_exchange_token: short.access_token },
    "",
  );
  const pages = await graph.get<{ data: PageAcct[] }>(
    "me/accounts",
    { fields: "id,name,access_token,instagram_business_account{id,username}" },
    long.access_token,
  );
  const page = (pages.data ?? []).find((p) => (cfg.meta.pageId ? p.id === cfg.meta.pageId : !!p.instagram_business_account));
  if (!page?.instagram_business_account) {
    throw new UserError("no Facebook Page with a linked Instagram professional account was granted", 422);
  }
  const acct: IgAccount = {
    igUserId: page.instagram_business_account.id,
    username: page.instagram_business_account.username ?? "",
    pageId: page.id,
    pageToken: page.access_token,
  };
  saveAccount(db, cfg.tokenEncKey, {
    ...acct,
    userToken: long.access_token,
    userTokenExpires: long.expires_in ? Date.now() + long.expires_in * 1000 : undefined,
  });
  return acct;
}
