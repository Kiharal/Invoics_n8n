# Yakwetu Growth Engine: Design

Status: draft v0.1, 2026-09-26. Built for the "B2C Consumer Conversion & Direct-Purchase Re-Engagement Engine" brief.

## 1. The brief in one line

Catch users who show buying intent but don't pay, find out why, and bring them back with a timely, personal, catalog-accurate message that ends in a purchase.

The brief lists three scenarios (A: browse recovery, B: payment troubleshooting, C: post-watch upsell). This design covers all three, but treats them as branches of one event-driven engine. That way the same plumbing (consent, frequency caps, attribution, logging) also serves activation, retention and event revenue. Adding a new branch is a config change, not a new system.

## 2. What the live site tells us (audit, 2026-09-26)

A first-visit walkthrough of www.yakwetu.africa on desktop Chrome surfaced these drop-off points. Each one maps to part of the brief and to an engine branch.

| # | Finding | Brief area | Engine response |
|---|---------|-----------|-----------------|
| F1 | Playback only works in Chrome on macOS, Windows and Android. Users learn this in a modal **after** clicking BUY. No iOS app. | Checkout friction (B) | **B2 Device bridge**: detect unsupported device at BUY and send a link to the Android app or Chrome. iOS users join a waitlist, which also gives the client a demand signal for an iOS build. |
| F2 | "Preview for FREE!" on the homepage cards failed in testing (fullscreen request rejected, video stayed paused). The preview on the title page works. | Browse recovery (A) | **A3 Preview rescue**: when the storefront reports `preview_failed`, send the working `/watch/<id>?clip=true` link. The weekly digest counts these failures so engineering sees the size of the bug. |
| F3 | The best selling points (free membership, no subscription, pay once and own forever, M-Pesa via Safaricom My OneApp) exist only on /about. The homepage says none of this. | Conversion (A) | **C2 Activation**: new sign-ups get a welcome message carrying the value proposition. The LLM prompt also lists these as the only allowed selling points. |
| F4 | BUY for a signed-out user lands on a bare sign-in form: no title, no price, sign-up is a small link. | Checkout friction (A/B) | **A4 Sign-up rescue**: if a user reaches /login or /register with a `ref` and doesn't finish within 20 minutes, remind them which film is waiting and that joining is free. Needs the client to confirm what `ref` encodes. |
| F5 | "Attend Premiere" jumps to a separate subdomain and first shows the price (KES 2,500) on checkout. | Checkout abandon (A) | **C3 Premiere recovery**: premiere tickets are the only high-value item on the site, so they justify WhatsApp. The date is real (17 Oct 2026), so a real deadline can be stated. No fake scarcity. |
| F6 | Title pages show five equal-weight buttons; BUY doesn't stand out. | Conversion | Not fixable by automation. Reported in the weekly digest as a product recommendation, backed by funnel numbers once events flow. |
| F7 | Brand spread across www., events., web.yakwetu.africa and MyMovies.Africa. | Trust | Every message uses one sender name ("YAKWETU™") and one link domain. A verified WhatsApp Business profile matters here. |
| F8 | Homepage embeds about 7 YouTube players and preloads 11 preview videos; about 6.5 s to full load on broadband. | Browse drop-off | Messages link straight to the title page, skipping the heavy homepage. The digest flags slow-load drop-off once GA4 data is available. |

Prices on the site are in **KES** (titles KES 5 to 199, premiere KES 2,500). The engine works in KES internally. A `price_usd` from any source is converted with `KES_PER_USD`.

## 3. The engine at a glance

```
            ┌───────────── product branches (what we say, when) ─────────────┐
 storefront │ A1 browse   A2 checkout  A3 preview  A4 sign-up                │
 events ──► │ B1 payment  B2 device                                           │
 scheduler  │ C1 upsell   C2 activation  C3 premiere  C4 win-back             │
            │ D  conversion attribution (no message)                          │
            └─────────────────────────────────────────────────────────────────┘
                                   │
            ┌───────────── technical branches (how, safely) ─────────────────┐
            │ T1 ingest guard: signature, schema, dedupe                      │
            │ T2 delay + re-check purchase                                    │
            │ T3 policy gate: consent, frequency cap, quiet hours, holdout    │
            │ T4 AI lane (LLM + guardrails) or template lane                  │
            │ T5 channel router with cost guard: WhatsApp / SMS / email       │
            │ T6 delivery + logging + attribution link                        │
            │ T7 error workflow, weekly insights digest                       │
            └─────────────────────────────────────────────────────────────────┘
```

## 4. Product branches

Every branch is a small config block in an Edit Fields node in n8n, so product people can tune delays and goals in the UI without touching code.

| ID | Trigger event | Delay (prod / demo) | Message kind | AI? | Goal |
|----|---------------|---------------------|--------------|-----|------|
| A1 Browse recovery | `preview_completed`, `title_viewed` | 2 h / 30 s | marketing | yes | Bring back the previewed film, or a close alternative from the catalog, framed as "own it forever". |
| A2 Checkout recovery | `checkout_started` with no purchase | 30 min / 30 s | marketing | no | Remind them of the exact title and price; one-tap link back. |
| A3 Preview rescue | `preview_failed` | 2 min / 10 s | utility | no | Apologise, send the working preview link. |
| A4 Sign-up rescue | `auth_abandoned` | 20 min / 20 s | marketing | no | "Joining is free. <Film> is waiting." |
| B1 Payment rescue | `payment_failed` | 1 min / 10 s | utility | no | Troubleshooting only. Advice by failure reason (STK timeout, wrong PIN, insufficient funds, card declined). Zero promotion. |
| B2 Device bridge | `unsupported_device` | 0 / 0 | utility | no | Android: app link. Desktop non-Chrome: Chrome link. iOS: waitlist. |
| C1 Post-watch upsell | `playback_completed`, `episode_completed` | 10 min / 20 s | marketing | yes | Next episode or season bundle for series; same-genre pick for films. |
| C2 Activation | `signup_completed` | 5 min / 10 s | marketing | no | Value proposition (F3) and one free preview to try. |
| C3 Premiere recovery | `premiere_checkout_abandoned` | 1 h / 30 s | marketing | no | Event date, venue, what the ticket includes. |
| C4 Win-back | `winback_due` (from scheduler) | 0 / 0 | marketing | yes | New or unwatched title in their most-bought genre. |
| D Conversion | `payment_succeeded` | none | none | no | Log revenue against the `nid` (nudge ID) that brought the user back. |

Why several branches skip the LLM: payment and device messages must be exact and fast, and a 7B model adds latency and risk without adding value. The LLM is used only where personalisation changes the outcome (choosing which film to pitch and how).

## 5. Technical branches

**T1 Ingest guard.** Webhook `POST /webhook/yak/events`. Optional HMAC-SHA256 signature in `x-yak-signature` (enabled when `YAK_WEBHOOK_SECRET` is set). Rejects events missing `event_id`, `event` or `user.id`. Dedupes on `event_id`.

**T2 Delay and re-check.** A Wait node holds the event for the branch delay, then asks the purchase API whether the user already bought the title. Bought means stop, silently.

**T3 Policy gate.** In order: already purchased, no consent for any usable channel, frequency cap (default 2 marketing messages per user per 7 days; utility messages exempt), quiet hours (21:00 to 08:00 Africa/Nairobi for marketing; skipped in demo mode), holdout group (default 10% of users never receive marketing nudges, so we can measure true lift). Every stop is logged with its reason.

**T4 AI lane.**
1. Pull up to 5 candidate titles from the catalog with rules (same title first, then same series, same genre, same language), excluding titles the user owns.
2. Ask Ollama (`/api/chat`, JSON mode, temperature 0.2) to pick one and write the message.
3. Guardrails: `pick_title_id` must be in the candidate list; message at most 300 characters; banned phrases (limited, hurry, expires, last chance, discount, % off, rent) are rejected.
4. Any failure falls back to a fixed template. The log records whether AI or fallback text was sent.

**T5 Channel router with cost guard.**
- WhatsApp: utility branches when WhatsApp consent exists; marketing only when `price_kes >= WHATSAPP_MIN_KES` (default 149). Premiere tickets always qualify. Single episodes never do.
- SMS (Africa's Talking): utility fallback when there's no WhatsApp consent.
- Email (SMTP, Mailtrap in demo): everything else with email consent.
- None: logged as suppressed.

**T6 Delivery and attribution.** Every link carries `utm_source=yak_engine&utm_medium=<channel>&utm_campaign=<branch>&nid=<nudge_id>`. The storefront passes `nid` back on `payment_succeeded`, so branch D can tie revenue to a specific message, branch and channel. Every send is logged with the exact text.

**T7 Operations.** An error workflow emails the team when any workflow fails. A weekly digest workflow summarises sends, suppressions, conversions and revenue by branch, plus counts of `preview_failed` and `unsupported_device` events, so product sees F1 and F2 in numbers.

## 6. How this grows the business

- **Revenue now:** A1, A2, B1 and C3 recover purchases that were already close.
- **Order value:** C1 turns single episodes (KES 5) into season bundles.
- **Retention:** C2 and C4 bring users back after sign-up and after quiet periods, without a subscription model to lean on.
- **Product intelligence:** B2 and A3 turn bugs and missing platforms into counted demand (for example: "N iOS users tried to buy this week"), which prioritises the fixes with the biggest payoff.
- **Profit discipline:** the holdout group proves incremental revenue, the cost guard keeps paid WhatsApp sends to items that can pay for them, and the frequency cap protects the list from fatigue.

## 7. Scaling path (after the demo)

| Demo | Production |
|------|-----------|
| Wait node holds each execution | `pending_nudges` table plus a cron sweeper; long Waits pile up in the executions table at volume |
| Workflow static data for dedupe and frequency caps | Postgres or Redis, shared by all workers |
| Single n8n process | n8n queue mode (Redis + multiple workers) |
| Google Sheets log | Postgres, with Looker Studio or Metabase on top |
| Ollama on CPU | GPU host or a hosted open model; cache per (title, language) |
| Send one message at a time | Batch with rate limits per the WhatsApp tier |

## 8. Open questions for the client

In addition to the list in the project context file:

1. Can the storefront emit `preview_failed`, `unsupported_device` and `auth_abandoned`? If not, which of these can GA4 or GTM see today?
2. What does the `ref` query parameter on /login and /register encode? Does it survive sign-up?
3. Will the storefront pass `nid` through to the purchase event (needed for attribution)?
4. Are premiere ticket buyers in the same user database as streaming users?
5. Is there an iOS roadmap? B2's waitlist makes most sense if the answer is yes.
