# Yakwetu Re-Engagement Engine: Design Decisions

Record of the design discussion held on 2026-09-26. Build happens in n8n today (Sat 26 Sep); presentation is Friday 2 Oct 2026.

This file records what we decided and why. It is not a full spec; the build in n8n is the source of truth for implementation details.

---

## 1. Starting point: what the live site told us

We walked through www.yakwetu.africa as a first-time visitor and mapped each drop-off point to the client brief.

| Finding on the site | Brief area | Why it matters for the engine |
|---|---|---|
| Playback only works in Chrome (macOS, Windows, Android). No iOS. Users only find out in a popup after clicking BUY. | Scenario B (checkout friction) | Some buyers are blocked, not hesitant. The fix is routing them to a supported device, not persuasion. |
| "Preview for FREE!" on homepage cards failed in testing; the preview on the title page works. | Scenario A (browse recovery) | Some "previewed but didn't buy" signals are users who never saw the preview. |
| Value proposition (free membership, no subscription, pay once and own forever, M-Pesa) only appears on /about. | Scenario A | Users don't understand the model. Messages can carry it. |
| BUY for a signed-out user lands on a bare sign-in form: no film, no price, sign-up is a small link. | Not named in the brief | A real drop-off point. Becomes the sign-up rescue branch. |
| Premiere ticket price (KES 2,500) is only revealed at checkout on a separate subdomain. | Scenario A | Noted; premiere branch deferred. |
| Titles cost KES 5 to 199. | All | Low price per title means per-message cost decides whether a channel is worth using. |

---

## 2. Decisions

### D1. One shared pipeline, branches as configuration

**Decision:** Build a single event-driven pipeline that every branch runs through. A branch is its trigger event plus a small config block (delay, message type, AI or template, goal).

**Why:** Consent, delays, purchase re-checks, channel choice and logging are built once. A new branch costs a trigger and a config block, not a new workflow. This is also the scaling story for the client.

### D2. Scope for the build

**Decision:**

| Role | Branch | Trigger event |
|---|---|---|
| Core | **A. Browse recovery** | `preview_completed` / `title_viewed`, no purchase |
| Core | **B. Payment rescue**, with **unsupported device** as a sub-case | `payment_failed`, `unsupported_device` |
| Add-on | **Sign-up rescue** | `auth_abandoned` (user hit /login or /register from a BUY and didn't finish) |
| Add-on | **Win-back** | Inactivity threshold reached (no event fires; detected by a scheduled scan) |

**Why:**
- A and B are the brief's core and must work end to end.
- The device sub-case sits under B because both are "buyer is stuck at checkout". It lets us show the biggest site finding without spending a branch slot.
- Sign-up rescue comes straight from our site audit, which shows we studied their real funnel.
- Win-back shows retention value, and proves the time-compression approach (D4).

**Considered and deferred:** C (post-watch upsell), premiere recovery, activation, weekly insights digest, holdout group, frequency caps. Candidates for later this week if time allows.

**Demo principle:** fewer branches that fully work live beat many that half-work. Depth where the brief is scored, breadth shown through the shared pipeline.

### D3. Pipeline stages

```
event in → drop duplicates (event_id) → wait (compressed delay) → re-check purchase
  → consent check → AI lane or template lane → guardrails → pick channel → send → log
```

Win-back enters differently: a scheduled scan finds inactive users and pushes a synthetic `winback_due` event into the same pipeline (skipping the wait).

| Stage | Decision |
|---|---|
| Drop duplicates | Ignore repeated `event_id`s. |
| Wait | Each branch has its own delay, set in real units and compressed in demo mode (D4). |
| Re-check purchase | Right before sending, ask the backend whether the user already bought the title. If yes, stop silently. |
| Consent | Never send on a channel the user hasn't consented to. No consent on any usable channel means stop and log. |
| AI or template | See D5. |
| Pick channel | See D6. |
| Log | Every outcome is logged: sent (with exact text), suppressed (with reason), failed. |

### D4. Time compression for the demo

**Problem:** Real delays range from about 1 minute (payment rescue) to about 30 days (win-back). One linear ratio cannot make both watchable: 1 s = 1 day makes a minute vanish; 1 s = 1 hour makes 30 days take 12 minutes.

**Decision:** Logarithmic compression. Delays are configured in real minutes; one function converts them in demo mode:

```
demo_seconds = 5.1 × ln(1 + real_minutes)
real_minutes = e^(demo_seconds / 5.1) − 1      (inverse, for display)
```

| Branch / threshold | Real | Demo |
|---|---|---|
| Payment rescue | 1 min | 3.5 s |
| Unsupported device | 0 | 0 s |
| Sign-up rescue | 20 min | 15.5 s |
| Browse recovery | 2 h | 24.5 s |
| Win-back inactivity threshold | 30 days | 54.5 s |

**Rules:**
- Delays are always configured in real units. Only one function performs the conversion. Turning demo mode off gives production timing with no other change. ("We didn't fake the timings, we compressed them.")
- Win-back uses the same function on its threshold: the scan compares time since the user's last activity against `compress(30 days)`. No separate virtual clock is needed.
- Order of events is preserved because the mapping is monotonic.
- The frontend can show both clocks, e.g. "real: 2 h · demo: 24 s".

### D5. Where the LLM is used

**Decision:**

| Branch | Lane | Reason |
|---|---|---|
| A. Browse recovery | **AI** | Choosing which film to pitch and how is where personalisation pays. |
| Win-back | **AI** | Pick a title from the user's favourite genre they don't own. |
| B. Payment rescue / device | Template | Transactional. Must be exact, fast and free of promotion. |
| Sign-up rescue | Template | Message is fixed: "joining is free, <film> is waiting". |

**Guardrails on AI output:**
- The LLM only picks from a candidate list we pass it (up to 5 titles chosen by rules: same title, same genre, same language, not already owned). It is not a recommender.
- Output is JSON: `pick_title_id`, `reason`, `message`, `channel`. Temperature about 0.2, Ollama JSON mode.
- Reject if `pick_title_id` isn't in the candidate list, message is over 300 characters, or it contains urgency or discount language (limited, hurry, expires, last chance, discount, % off, rent).
- Any rejection or parse failure falls back to a fixed template. The log records AI vs fallback.
- Allowed selling points: free membership, no subscription, own it forever, pay with M-Pesa.

### D6. Channels

| Branch | Channel rule |
|---|---|
| B. Payment rescue / device | WhatsApp if consented (utility message), else SMS (logged), else email. |
| A. Browse recovery, win-back | Email by default. WhatsApp only if the title price is at or above a configurable KES threshold. |
| Sign-up rescue | Email (we have the address from the sign-in attempt, if any); WhatsApp if phone and consent exist. |

**Live in the demo:** email via Mailtrap (audience can see the inbox); WhatsApp on the Meta test number if setup works in time. SMS is logged, not sent.

**Why:** Titles are cheap (KES 5 to 199), so paid WhatsApp marketing messages only make sense for higher-priced items. Payment and device messages are utility messages and justify WhatsApp.

### D7. Branch behaviour

**A. Browse recovery**
- Trigger: user previewed or viewed a title, no purchase.
- Delay: 2 h real.
- Message: the previewed film or a close alternative, framed as "own it forever", with a direct buy link.
- Note: preview-failure users (site finding) look the same as uninterested users until the storefront can report `preview_failed`.

**B. Payment rescue**
- Trigger: `payment_failed` with a `failure_reason` (STK timeout, wrong PIN, insufficient funds, card declined).
- Delay: 1 min real, giving the user a moment to retry on their own before the re-check.
- Message: troubleshooting steps matched to the reason, plus an alternative payment path. No promotional content.

**B sub-case: unsupported device**
- Trigger: `unsupported_device` at BUY.
- Delay: none.
- Message: Android gets the app link; desktop non-Chrome gets "open in Chrome"; iOS gets a waitlist message. The log counts these as a demand signal for the client.

**Sign-up rescue**
- Trigger: user reached /login or /register from a BUY (carrying the title) and didn't complete within the delay.
- Delay: 20 min real.
- Message: "Joining YAKWETU™ is free. <Film> is waiting for you", with a link back to that title.
- Depends on the client confirming what the `ref` parameter carries. Mocked for the demo.

**Win-back**
- Trigger: scheduled scan finds users inactive for 30 days real (54.5 s demo).
- Message: an unowned title from their most-bought genre, chosen by the LLM from candidates.
- Scan frequency in demo: every ~10 s so the threshold is hit promptly.

### D8. Mock frontend

**Decision:** A mock storefront that:
- fires each event with a button: preview, checkout, payment failure (choose reason), unsupported device (choose platform), abandon sign-in, set a user inactive;
- lets the presenter pick a demo user (with consent flags and language);
- shows a live log panel: each pipeline step, the compressed delay counting down with the real equivalent, the decision taken (sent / suppressed + reason), and the exact message text.

**Why:** It proves the workflow runs end to end even if WhatsApp delivery fails on the day; the logs are the evidence.

### D9. Data for the demo

- Mock catalog built from real Yakwetu titles, priced in KES as on the site.
- Mock purchase status held by the mock backend, so the re-check step has something real to call.
- One log store that both n8n writes to and the frontend reads from.

---

## 3. Deferred (later this week, if time allows)

- C. Post-watch upsell (episode, then season bundle)
- Premiere recovery (KES 2,500; real deadline 17 Oct 2026)
- Activation / welcome message
- Frequency caps and quiet hours (must use the same compression function when added)
- Holdout group for measuring true lift
- Attribution link (`nid`) and conversion logging
- Weekly insights digest for the client team

---

## 4. Open questions for the client

1. Can the storefront emit `preview_failed`, `unsupported_device` and `auth_abandoned`? If not, what can GA4/GTM see today?
2. What does the `ref` parameter on /login and /register encode, and does it survive sign-up?
3. Checkout currency and methods (KES via M-Pesa STK, cards), and typical failure/timeout rates?
4. Consent status of existing users for WhatsApp and email marketing?
5. Is there an iOS roadmap?
6. Who owns user and payment data given the MyMovies.Africa backend?
