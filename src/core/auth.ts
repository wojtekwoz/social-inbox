import type { DB } from "./db.js";
import { randomKey, sha256 } from "./crypto.js";

export type Scope = "read" | "draft" | "send" | "approve";
export const SCOPES: Scope[] = ["read", "draft", "send", "approve"];
export const AGENT_SCOPES: Scope[] = ["read", "draft", "send"];

export interface Principal {
  name: string;
  scopes: Set<Scope>;
}

/** API keys are random 32 bytes, stored only as SHA-256 hashes. */
export class Keys {
  constructor(private db: DB) {}

  /** Register a key given in the environment (idempotent; only its hash is stored). */
  ensure(name: string, key: string, scopes: Scope[]): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, scopes = excluded.scopes`,
      )
      .run(`env:${name}`, name, sha256(key), scopes.join(","), Date.now());
  }

  create(name: string, scopes: Scope[]): string {
    const key = randomKey();
    this.db
      .prepare("INSERT INTO api_keys (id, name, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`k:${sha256(key).slice(0, 12)}`, name, sha256(key), scopes.join(","), Date.now());
    return key;
  }

  revoke(name: string): number {
    return this.db.prepare("DELETE FROM api_keys WHERE name = ?").run(name).changes;
  }

  list(): { name: string; scopes: string; last_used: number | null }[] {
    return this.db.prepare("SELECT name, scopes, last_used FROM api_keys ORDER BY created_at").all() as never;
  }

  verify(key: string | undefined | null): Principal | undefined {
    if (!key) return undefined;
    // Lookup by hash: equality on a SHA-256 digest does not leak the key through timing.
    const row = this.db.prepare("SELECT id, name, scopes FROM api_keys WHERE hash = ?").get(sha256(key)) as
      | { id: string; name: string; scopes: string }
      | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE api_keys SET last_used = ? WHERE id = ?").run(Date.now(), row.id);
    return { name: row.name, scopes: new Set(row.scopes.split(",") as Scope[]) };
  }
}

export function parseScopes(s: string): Scope[] {
  const out = s.split(",").map((x) => x.trim()) as Scope[];
  for (const x of out) if (!SCOPES.includes(x)) throw new Error(`unknown scope ${x}`);
  return out;
}

export function bearer(header: string | undefined | null): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m?.[1]?.trim();
}
