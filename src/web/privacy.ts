import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "../core/crypto.js";

// Public pages Meta App Review requires: privacy policy and data-deletion callback.

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}</style>
</head><body>${body}</body></html>`;

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function privacyHtml(publicUrl: string, contact: string): string {
  return page(
    "Privacy policy — Social Inbox",
    `<h1>Privacy policy</h1>
<p>Social Inbox is a self-hosted tool that lets the account owner read and answer messages and comments on
their own Instagram professional account. It is operated by the account owner for their own use only.</p>
<h2>What we process</h2>
<ul><li>Direct messages sent to the account, comments and mentions on its posts: text, sender username and
platform IDs, timestamps.</li><li>OAuth tokens for the connected account, encrypted at rest.</li></ul>
<h2>Why</h2><p>To manage the owner's own accounts (legitimate interest). No ads, no profiling, no selling of data.
Content is not sent to third parties other than the platform APIs and the owner's authenticated assistant.</p>
<h2>Retention</h2><p>Raw API payloads are deleted after 30 days; message text after 12 months. Data is stored in the EU.</p>
<h2>Deletion</h2><p>Ask the account owner, or remove the app from your Facebook/Instagram settings; Meta then calls
<code>${esc(publicUrl)}/data-deletion</code> and we delete what we hold about you.</p>
<h2>Contact</h2><p>${esc(contact)}</p>`,
  );
}

export function deletionStatusHtml(code: string, found?: { n: number; ts: number }): string {
  return page(
    "Data deletion status",
    found
      ? `<h1>Deletion complete</h1><p>Request <code>${esc(code)}</code> processed on ${new Date(found.ts).toISOString()}; ${found.n} record(s) deleted.</p>`
      : `<h1>Unknown request</h1><p>No deletion request with code <code>${esc(code)}</code>.</p>`,
  );
}

/** Parses and verifies Meta's `signed_request` (HMAC-SHA256 over the payload segment with the app secret). */
export function parseSignedRequest(signed: string, appSecret: string): { user_id?: string; algorithm?: string } | undefined {
  const [sig, payload] = signed.split(".", 2);
  if (!sig || !payload) return undefined;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  if (!safeEqual(Buffer.from(sig, "base64url"), expected)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.algorithm?.toUpperCase() === "HMAC-SHA256" ? data : undefined;
  } catch {
    return undefined;
  }
}

export const confirmationCode = () => randomBytes(9).toString("base64url");
