import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "../core/crypto.js";

// Public pages Meta App Review requires: home, privacy policy, terms, data-deletion instructions + callback.

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}h2{font-size:1.1rem}footer{margin-top:3rem;font-size:.9rem;color:#666}</style>
</head><body>${body}
<footer><a href="/">Home</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></footer>
</body></html>`;

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Who runs this instance, shown on the public pages. */
export interface Operator {
  /** Contact for privacy requests (email). */
  contact: string;
  /** Legal name / business details of the operator (optional, e.g. "Jane Doe, sole proprietor, Gdynia, Poland"). */
  name?: string;
}

const operatorLine = (o: Operator) =>
  o.name ? `${esc(o.name)} (the "operator", the owner of the connected Instagram account)` : `the owner of the connected Instagram account (the "operator")`;

export function homeHtml(o: Operator): string {
  return page(
    "Social Inbox",
    `<h1>Social Inbox</h1>
<p>Social Inbox is a private, self-hosted tool that ${operatorLine(o)} uses to read and answer direct messages,
comments and mentions on their own Instagram professional account. It is not a public service and has no sign-up.</p>
<p>It is open source (MIT): <a href="https://github.com/wojtekwoz/social-inbox">github.com/wojtekwoz/social-inbox</a>.</p>
<p>Contact: ${esc(o.contact)}</p>`,
  );
}

export function privacyHtml(publicUrl: string, o: Operator): string {
  return page(
    "Privacy policy — Social Inbox",
    `<h1>Privacy policy</h1>
<p>Social Inbox is a self-hosted tool that lets ${operatorLine(o)} read and answer messages and comments on
their own Instagram professional account. It is operated by the account owner for their own use only.
The operator is the data controller.</p>
<h2>What we process</h2>
<ul>
<li>Direct messages sent to the account (including story replies and button taps), comments and mentions on its posts:
text, sender username and Instagram-scoped IDs, timestamps.</li>
<li>Email addresses that people choose to send in a direct message (for example to receive a free resource).</li>
<li>Replies sent from the account and a log of who approved them.</li>
<li>OAuth tokens for the connected account, encrypted at rest.</li>
</ul>
<h2>Why and on what basis</h2>
<p>To answer people who contact the account, to send what they asked for, and to count how well each automated reply
works (legitimate interest, GDPR Art. 6(1)(f)). Email addresses are used only to send what the person asked for and, if
they agreed, the operator's newsletter (consent, Art. 6(1)(a)); they can unsubscribe at any time.
No ads, no profiling for advertising, no selling of data.</p>
<h2>Who receives it</h2>
<ul>
<li>Meta Platforms (Instagram), which delivers the messages.</li>
<li>The hosting provider of the operator's server in the EU.</li>
<li>The operator's email provider (for example MailerLite or Plunk), only for email addresses people sent.</li>
<li>AI assistants the operator uses with their own authenticated key, to summarize messages and draft replies.
A person approves replies before they are sent, except fixed automatic answers to keywords the sender typed.</li>
</ul>
<h2>Where and how long</h2>
<p>Data is stored in a SQLite database on the operator's server in the EU. Raw API payloads are deleted after 30 days;
message text after 12 months.</p>
<h2>Your rights and deletion</h2>
<p>You can ask for a copy of your data, its correction or deletion, or object to processing, by writing to
${esc(o.contact)}. See <a href="${esc(publicUrl)}/data-deletion">${esc(publicUrl)}/data-deletion</a> for how deletion works.
You can also complain to your data protection authority (in Poland: UODO).</p>
<h2>Contact</h2><p>${esc(o.contact)}</p>`,
  );
}

export function termsHtml(o: Operator): string {
  return page(
    "Terms — Social Inbox",
    `<h1>Terms of use</h1>
<p>Social Inbox is a private tool used only by ${operatorLine(o)} to manage their own Instagram account.
There are no other users. If you message or comment on that account, Instagram's own terms apply to you, and the
<a href="/privacy">privacy policy</a> explains what happens to your data.</p>
<p>Automatic replies are only sent after you write first (a message, a comment with a keyword, a story reply or a button tap)
and within Instagram's messaging windows. You can stop them at any time by writing STOP or by blocking the account.</p>
<p>The software is open source under the MIT license and provided as is.</p>
<p>Contact: ${esc(o.contact)}</p>`,
  );
}

export function deletionInstructionsHtml(o: Operator): string {
  return page(
    "Data deletion — Social Inbox",
    `<h1>Data deletion</h1>
<p>To delete the data Social Inbox holds about you (your messages, comments, username, Instagram-scoped ID and any email
address you sent):</p>
<ol>
<li>Email ${esc(o.contact)} with the subject "Delete my data" and your Instagram username. We delete everything we hold
about you within 30 days (usually within a few days) and confirm by email.</li>
<li>Or, if you connected Social Inbox to your own Facebook or Instagram account, remove it in
Facebook Settings &gt; Apps and websites (or Instagram Settings &gt; Apps and websites). Meta then notifies us and we
delete the data automatically; you get a confirmation code you can check on this page.</li>
</ol>
<p>Deleting a message in Instagram ("unsend") also removes it from Instagram itself; email us if you want our copy removed too.</p>`,
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
