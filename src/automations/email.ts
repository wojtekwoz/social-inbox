import type { Config } from "../config.js";
import { TransientError } from "../core/errors.js";

// Email list providers for the push_email step. Credentials come only from env;
// HTTP goes through an injectable fetch so tests never touch the network.

export type Fetch = typeof fetch;

export interface EmailLead {
  email: string;
  tags: string[];
  group?: string;
  event?: string;
  source: { channel: "instagram"; flow: string; run: string; media?: string };
}

export interface EmailProvider {
  readonly name: string;
  push(lead: EmailLead): Promise<{ id?: string }>;
}

export type EmailProviders = Partial<Record<string, EmailProvider>>;

async function post(f: Fetch, name: string, url: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new TransientError(`${name} network: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Never echo the request (it carries the key and the email); the status and provider message are enough.
    const msg = `${name} ${res.status}: ${String(json.message ?? json.error ?? "error").slice(0, 120)}`;
    if (res.status >= 500 || res.status === 429) throw new TransientError(msg);
    throw new Error(msg);
  }
  return json;
}

/** Plunk (hosted or self-hosted): `POST /v1/track` creates/updates the contact and fires an event for Plunk automations. */
export class PlunkProvider implements EmailProvider {
  readonly name = "plunk";
  constructor(private o: { apiKey: string; baseUrl: string; fetch?: Fetch }) {}

  async push(lead: EmailLead) {
    const r = await post(this.o.fetch ?? fetch, this.name, `${this.o.baseUrl}/v1/track`, this.o.apiKey, {
      event: lead.event ?? "instagram-lead",
      email: lead.email,
      subscribed: true,
      data: {
        source: lead.source.channel,
        flow: lead.source.flow,
        ...(lead.source.media ? { media: lead.source.media } : {}),
        ...(lead.tags.length ? { tags: lead.tags.join(",") } : {}),
      },
    });
    const contact = r.contact as string | { id?: string } | undefined;
    return { id: typeof contact === "string" ? contact : contact?.id };
  }
}

/** MailerLite (new API): `POST /api/subscribers` upserts the subscriber into a group. */
export class MailerLiteProvider implements EmailProvider {
  readonly name = "mailerlite";
  constructor(private o: { apiKey: string; baseUrl: string; groupId?: string; fetch?: Fetch }) {}

  async push(lead: EmailLead) {
    const group = lead.group ?? this.o.groupId;
    const r = await post(this.o.fetch ?? fetch, this.name, `${this.o.baseUrl}/api/subscribers`, this.o.apiKey, {
      email: lead.email,
      ...(group ? { groups: [group] } : {}),
    });
    return { id: (r.data as { id?: string } | undefined)?.id };
  }
}

/** In-memory provider for tests and demos. */
export class FakeEmailProvider implements EmailProvider {
  pushed: EmailLead[] = [];
  failNext: Error[] = [];
  constructor(readonly name = "fake") {}

  async push(lead: EmailLead) {
    const err = this.failNext.shift();
    if (err) throw err;
    this.pushed.push(lead);
    return { id: `c${this.pushed.length}` };
  }
}

/** Providers that have credentials configured. Missing keys = provider off. */
export function emailProviders(cfg: Config, f?: Fetch): EmailProviders {
  const out: EmailProviders = {};
  const e = cfg.email;
  if (e.plunkApiKey) out.plunk = new PlunkProvider({ apiKey: e.plunkApiKey, baseUrl: e.plunkApiUrl, fetch: f });
  if (e.mailerliteApiKey)
    out.mailerlite = new MailerLiteProvider({ apiKey: e.mailerliteApiKey, baseUrl: e.mailerliteApiUrl, groupId: e.mailerliteGroupId, fetch: f });
  return out;
}
