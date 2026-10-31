import { decrypt, encrypt, parseKey } from "../../core/crypto.js";
import type { DB } from "../../core/db.js";

// The single connected Instagram professional account and its encrypted Page token.

export interface IgAccount {
  igUserId: string;
  username: string;
  pageId: string;
  pageToken: string;
}

const ID = "ig";

export function saveAccount(db: DB, encKey: string, a: IgAccount & { userToken?: string; userTokenExpires?: number }): void {
  const key = parseKey(encKey);
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO accounts (id, net, native_id, username, page_id, created_at, updated_at) VALUES (?, 'ig', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET native_id = excluded.native_id, username = excluded.username, page_id = excluded.page_id, updated_at = excluded.updated_at`,
    ).run(ID, a.igUserId, a.username, a.pageId, now, now);
    const put = db.prepare(
      `INSERT INTO tokens (account_id, kind, enc, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, kind) DO UPDATE SET enc = excluded.enc, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    );
    put.run(ID, "page", encrypt(a.pageToken, key), null, now);
    if (a.userToken) put.run(ID, "user", encrypt(a.userToken, key), a.userTokenExpires ?? null, now);
  })();
}

export function loadAccount(db: DB, encKey: string | undefined): IgAccount | undefined {
  if (!encKey) return undefined;
  const row = db.prepare("SELECT native_id, username, page_id FROM accounts WHERE id = ?").get(ID) as
    | { native_id: string; username: string; page_id: string }
    | undefined;
  const tok = db.prepare("SELECT enc FROM tokens WHERE account_id = ? AND kind = 'page'").get(ID) as { enc: string } | undefined;
  if (!row || !tok) return undefined;
  return { igUserId: row.native_id, username: row.username, pageId: row.page_id, pageToken: decrypt(tok.enc, parseKey(encKey)) };
}

/** Re-encrypt every stored token with a new key. */
export function rotateKey(db: DB, oldKey: string, newKey: string): number {
  const o = parseKey(oldKey);
  const n = parseKey(newKey);
  const rows = db.prepare("SELECT account_id, kind, enc FROM tokens").all() as { account_id: string; kind: string; enc: string }[];
  db.transaction(() => {
    for (const r of rows)
      db.prepare("UPDATE tokens SET enc = ? WHERE account_id = ? AND kind = ?").run(encrypt(decrypt(r.enc, o), n), r.account_id, r.kind);
  })();
  return rows.length;
}
