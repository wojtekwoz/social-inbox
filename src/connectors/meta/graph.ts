import { createHmac } from "node:crypto";
import { TransientError } from "../../core/errors.js";

// Minimal Graph API client. Adds appsecret_proof when the app secret is known,
// classifies errors as transient (retry) or permanent, and follows paging with a cap.

export type Fetch = typeof fetch;

export interface GraphOptions {
  base: string;
  version: string;
  appSecret?: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public code?: number,
    public status?: number,
  ) {
    super(message);
  }
}

// Graph error codes worth retrying: unknown/service/rate-limit/throttling.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 80001, 80002, 80006]);

export interface Page<T> {
  data: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

export class Graph {
  private f: Fetch;
  constructor(private o: GraphOptions) {
    this.f = o.fetch ?? fetch;
  }

  url(path: string, params: Record<string, string | number | boolean | undefined> = {}, token?: string): string {
    const u = new URL(path.startsWith("http") ? path : `${this.o.base}/${this.o.version}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    if (token) {
      u.searchParams.set("access_token", token);
      if (this.o.appSecret) u.searchParams.set("appsecret_proof", createHmac("sha256", this.o.appSecret).update(token).digest("hex"));
    }
    return u.toString();
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new TransientError(`network: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    const err = (json as { error?: { message?: string; code?: number; is_transient?: boolean } }).error;
    if (!res.ok || err) {
      const msg = `graph ${res.status}${err?.code ? ` code ${err.code}` : ""}: ${err?.message ?? "error"}`;
      if (res.status >= 500 || res.status === 429 || err?.is_transient || (err?.code !== undefined && TRANSIENT_CODES.has(err.code)))
        throw new TransientError(msg);
      throw new GraphError(msg, err?.code, res.status);
    }
    return json as T;
  }

  get<T>(path: string, params: Record<string, string | number | boolean | undefined>, token: string): Promise<T> {
    return this.call<T>("GET", this.url(path, params, token));
  }

  post<T>(path: string, params: Record<string, string | number | boolean | undefined>, token: string, body?: unknown): Promise<T> {
    return this.call<T>("POST", this.url(path, params, token), body);
  }

  del<T>(path: string, token: string): Promise<T> {
    return this.call<T>("DELETE", this.url(path, {}, token));
  }

  /** Fetches pages until `stop` returns true for an item, `next` runs out, or `maxPages` is hit. */
  async *paginate<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    token: string,
    maxPages = 5,
  ): AsyncGenerator<T> {
    let url: string | undefined = this.url(path, params, token);
    for (let p = 0; url && p < maxPages; p++) {
      const page: Page<T> = await this.call<Page<T>>("GET", url);
      for (const it of page.data ?? []) yield it;
      url = page.paging?.next;
    }
  }
}
