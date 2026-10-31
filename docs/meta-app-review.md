# Meta Business Verification & App Review pack

Prepared 31 Oct 2026 for app `1829246938496408` (Social Inbox, Instagram API **with Facebook Login for Business**, `graph.facebook.com`, Page token). Goal: reply from Social Inbox to everyone who messages or comments on @wozu_co, not only app testers. Nothing here has been submitted; the account owner does every submit/upload step.

Meta's track for this: [Apps For Your Own Business](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/app-review/apps-for-your-own-business) (the app only processes messages sent to the owner's own Instagram account).

## Why review is needed

- With Standard Access the Send API only reaches people with a role on the app ([Send a message: Limitations](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message)).
- Webhooks for people without an app role need App Review approval, and the app must be Live ([Instagram Messaging webhooks](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/), [Webhooks setup: Requirements](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)). `comments` / `live_comments` webhooks need Advanced Access.
- Advanced Access requires Business Verification ([Access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels/)). Do Business Verification first.

## Permissions to request (Advanced Access)

| Permission / feature | Why the code needs it |
|---|---|
| `instagram_manage_messages` | Read DM conversations (`/{page-id}/conversations?platform=instagram`), receive `messages` / `messaging_postbacks` webhooks, send replies via `POST /{page-id}/messages`. |
| `instagram_manage_comments` | Read comments and mentions, reply to comments, send one private reply per comment (`recipient.comment_id`), hide/unhide; `comments` + `mentions` webhooks. |
| `instagram_basic` | Read the connected account's profile and media list (to know which posts to poll for comments). Dependency of the two above. |
| `pages_show_list` | Find the Facebook Page linked to @wozu_co during login (`/me/accounts`). |
| `pages_read_engagement` | Read Page-linked content and the Page token's Instagram data; listed by Meta as required for the Instagram webhook fields. |
| `pages_manage_metadata` | Subscribe the Page to the app's webhooks (`POST /{page-id}/subscribed_apps`). |
| `business_management` | Listed by Meta as a dependency of `instagram_manage_messages` under Facebook Login for Business. Added to the login scopes in this PR. |
| Human Agent (feature, optional) | Lets a person (not automation) reply up to 7 days after the last message. Code path exists behind `META_HUMAN_AGENT`; automation never uses the tag. |

Not needed: `pages_messaging` (Facebook Messenger only), Instagram Public Content Access, `instagram_manage_insights`, `instagram_content_publishing`.

## Use-case texts (paste into App Review)

**instagram_manage_messages**
> Social Inbox is a private inbox and automation tool used only by the owner of the Instagram professional account @wozu_co (a one-person business) to process messages sent to that one account. It is both an automated experience and a custom inbox. Automated: when someone sends a keyword (for example KURS) or taps an ice breaker or quick reply, the app answers within seconds with a fixed message and, where relevant, quick replies or one button. Custom inbox: every other message is shown to the owner, who reads it and writes or approves each reply before it is sent; nothing outside fixed keyword answers is sent without a person approving it. We read conversations and messages to show them in the inbox and to match keywords; we store them only for this account's own customer communication. Unsent messages are removed from the inbox. To initiate: send any direct message to @wozu_co on Instagram, or send the word KURS to see the automated reply with quick replies.

**instagram_manage_comments**
> The owner of @wozu_co uses Social Inbox to read comments and mentions on their own posts and reels and to answer them. When a comment contains a keyword the owner set for that post (for example "CLAUDE"), the app sends one private reply to the commenter (one message per comment, within 7 days, as the Private Replies API allows) offering the resource they asked for, and may post a short public reply. The owner can also reply to, hide or unhide comments from the inbox. Comment data is used only to answer the commenter and to count how many people each post's keyword reached.

**instagram_basic**
> Used to read the connected Instagram professional account's ID, username and list of media, so the app knows which posts and reels to read comments from and can show which post a comment belongs to. Dependency for instagram_manage_messages and instagram_manage_comments.

**pages_show_list**
> During Facebook Login for Business the owner selects the Facebook Page linked to @wozu_co. We call /me/accounts once to find that Page and its linked Instagram professional account. No other Page data is used.

**pages_read_engagement**
> Required with the Page access token to read the linked Instagram account's conversations, comments and mentions and to receive the corresponding webhooks for @wozu_co. Data is shown only to the account owner in their inbox.

**pages_manage_metadata**
> Used once to subscribe the owner's Facebook Page (linked to @wozu_co) to this app's webhooks, so new Instagram messages, button taps, comments and mentions arrive in real time and automated answers go out within seconds instead of on a polling delay.

**business_management**
> Requested as a dependency of instagram_manage_messages for Instagram Messaging under Facebook Login for Business. In the login flow the owner explicitly grants the app access to the business assets (the Page linked to @wozu_co). The app does not read or change any other business settings.

**Human Agent (optional)**
> @wozu_co is run by one person who answers questions about courses and website projects personally. Many messages arrive in the evening or at the weekend and need a considered answer (pricing, project scope), so a reply sometimes comes more than 24 hours after the last message. The Human Agent tag is used only for replies written and approved by that person in the inbox; automated keyword answers never use it.

## Reviewer test instructions (Verification details are optional for own-business apps)

- Platform: Website, `https://inbox.wozu.co`. Credentials: leave blank (single-owner tool, no sign-up).
- Step 1: On Instagram, send a direct message "Hi" to @wozu_co. It appears in the owner's Social Inbox; the owner replies within 24 hours (the screencast shows this end to end).
- Step 2: Send "KURS". The automated answer arrives within 30 seconds with quick replies; tap one to continue.
- Step 3: Open a recent reel on @wozu_co and comment "CLAUDE". You receive one private reply in your DMs (it may land in Message requests if you do not follow @wozu_co).
- Step 4: Send a message and unsend it; it disappears from the owner's inbox.
- Step 5: Data deletion: https://inbox.wozu.co/data-deletion (instructions + Meta callback). Privacy: https://inbox.wozu.co/privacy.

## Screencast script

Record only after the owner approves turning on sending for tester accounts. In dev mode Meta itself only delivers sends to people with an app role, and each manual reply still needs approval with the admin key. Use English UI, captions for Polish text, 1080p, no secrets on screen (blur API keys and tokens).

Video A, login and permissions (about 1.5 min; for business_management, pages_show_list, instagram_basic, pages_manage_metadata)
1. Title card: "Social Inbox: private inbox for @wozu_co".
2. Terminal: `sinbox connect meta` prints the login URL; open it.
3. Facebook Login for Business dialog: pick the business, the Page linked to @wozu_co and the Instagram account; show every permission screen; Continue.
4. Callback page "Connected @wozu_co". Caption: "The app only works with this one account."
5. `sinbox sync` then `sinbox ov`: show the account, counts of DMs and comments.
6. Graph API Explorer (or the app) subscribing the Page to webhooks; caption "pages_manage_metadata: subscribe to webhooks".

Video B, messages (about 3 min; instagram_manage_messages, Human Agent)
1. Split screen: phone with the tester Instagram account, laptop with Social Inbox.
2. Tester sends "Hi, how much is the course?" to @wozu_co. Laptop: the DM appears (`sinbox ls` / inbox view).
3. Owner drafts a reply, approves it, it is sent; phone shows the reply arriving.
4. Tester sends "KURS": automated answer with quick replies arrives within 30 s; tester taps a quick reply; the next step arrives.
5. Tester sends a message and unsends it; inbox no longer shows it.
6. (Human Agent) Show a thread older than 24 h: plain reply is refused with the window message; reply with HUMAN_AGENT is approved by the owner and sent.

Video C, comments (about 2.5 min; instagram_manage_comments, pages_read_engagement)
1. Tester comments "CLAUDE" on a @wozu_co reel.
2. Laptop: the comment appears in the inbox with its post.
3. Private reply goes out (automated rule or owner-approved); phone: DM arrives (Requests folder if not following).
4. Owner replies publicly to another comment and hides a spam comment; phone shows both.

Video D, data deletion (about 40 s; can be appended to A)
1. Open https://inbox.wozu.co/privacy and https://inbox.wozu.co/data-deletion.
2. `sinbox admin forget <igsid>` removes a tester's data; `sinbox admin export <igsid>` now returns nothing.

## App settings checklist (App Dashboard > App settings > Basic)

- App icon 1024x1024, no Meta/Instagram logos; display name without "Instagram", "IG" or "Facebook".
- Category: Business and pages.
- Privacy policy URL: https://inbox.wozu.co/privacy (live).
- Terms of service URL: https://inbox.wozu.co/terms (after this PR is deployed).
- User data deletion: callback URL https://inbox.wozu.co/data-deletion (live, verifies `signed_request`), or instructions URL (same address, after deploy).
- App domains: inbox.wozu.co, wozu.co. Contact email: yo@wozu.co. Business email in Developer settings.
- Platform: Website, site URL https://inbox.wozu.co.
- Facebook Login for Business: redirect URI https://inbox.wozu.co/oauth/meta/callback; Login configuration includes business_management.
- App connected to the verified business portfolio.

## Known gaps before recording

- Unsent messages: the webhook handler currently ignores `is_deleted` events. Reviewers ask to see unsent messages handled; mark the item deleted when that event arrives.
- There is no web UI; the screencast uses the CLI. Meta asks for a visible login button and an app reviewers can load externally, so a minimal web inbox page may be needed if the first round is rejected.
