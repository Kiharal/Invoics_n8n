# Yakwetu Re-Engagement Engine: Implementation Roadmap

Build starts Sat 26 Sep 2026. Presentation Fri 2 Oct 2026.
Scope is the one locked in `decisions.md` (D2). `growth-engine-design.md` is the long-term vision and goes on a "what's next" slide, not into this week's build.

---

## 0. Team split

| | Frontend track | Automations track |
|---|---|---|
| Owns | Mock storefront, mock backend (catalog, users, purchases, logs API), live log panel | n8n pipeline, branch configs, Ollama AI lane, guardrails, channel router, Mailtrap/WhatsApp delivery, scheduler |
| Source of truth | `/storefront`, `/backend` | `/workflows` (exported JSON) |
| Done means | Every demo button fires a valid event and the panel shows every pipeline step live | Every in-scope branch runs from webhook to delivered message with full logging |

**Why the mock backend sits with the frontend track:** the automations track only needs it as an API. If the frontend team owns it, the two tracks meet at one contract (section 1) and nobody waits on anybody after day 1.

**Why the log store is the backend, not Google Sheets:** D9 needs one store that n8n writes and the panel reads live. Sheets adds OAuth, rate limits and polling lag to the one thing the audience watches. A small API over SQLite is simpler and faster. Sheets can still get a nightly export if the client wants to see it there.

---

## 1. Contracts (agree before splitting, today)

Freeze these in `/docs/contracts.md` as v1. Any change after Sunday needs both track leads to agree.

### 1.1 Event payload (storefront to n8n)

`POST {N8N_URL}/webhook/yak/events`

```json
{
  "event_id": "uuid",
  "event": "preview_completed | title_viewed | payment_failed | unsupported_device | auth_abandoned | payment_succeeded",
  "ts": "ISO-8601",
  "user_id": "u_001",
  "title_id": "t_40sticks",
  "context": {
    "failure_reason": "stk_timeout | wrong_pin | insufficient_funds | card_declined | null",
    "platform": "android | ios | desktop_non_chrome | null",
    "seconds_watched": 90,
    "ref": "t_40sticks"
  },
  "demo_mode": true
}
```

User details (consent, language, phone, email) are NOT in the event. n8n fetches them from the backend. This keeps events small and means consent is always read fresh.

`winback_due` is never sent by the storefront. n8n's scheduler creates it (D3).

### 1.2 Backend API (frontend track builds, automations track consumes)

| Method | Path | Returns | Used by |
|---|---|---|---|
| GET | `/catalog` | titles: id, name, genre, languages, price_kes, series_id, episode, buy_url | AI lane candidate pick |
| GET | `/users/:id` | name, phone, email, language, consent `{whatsapp, sms, email}`, owned title ids, last_active_at, top_genre | Consent check, candidates |
| GET | `/users` | all demo users | Storefront user picker |
| GET | `/purchases/check?user_id=&title_id=` | `{purchased: bool}` | Re-check stage |
| POST | `/purchases` | records a purchase, updates last_active_at | Storefront BUY button |
| POST | `/users/:id/inactive` | sets last_active_at far in the past | "Set user inactive" button |
| GET | `/users/inactive?threshold_s=` | users past threshold with no pending win-back | Win-back scan |
| POST | `/dedupe/:event_id` | `{seen: bool}` (records on first call) | Drop-duplicates stage |
| POST | `/logs` | stores a log row | n8n, every stage |
| GET | `/logs?since=` or SSE `/logs/stream` | log rows | Live panel |

Auth for the demo: one shared header `x-yak-key` from `.env`.

### 1.3 Log row (n8n writes, panel reads)

```json
{
  "ts": "ISO-8601",
  "run_id": "n8n execution id",
  "event_id": "uuid",
  "nudge_id": "n_xxx",
  "branch": "A_browse | B_payment | B_device | signup_rescue | winback",
  "stage": "received | duplicate | waiting | rechecked | consent | ai | fallback | guardrail | channel | sent | suppressed | failed",
  "status": "ok | stop | error",
  "reason": "already_purchased | no_consent | guardrail:banned_phrase | ...",
  "real_delay_min": 120,
  "demo_delay_s": 24.5,
  "channel": "whatsapp | sms | email | none",
  "message": "exact text sent, or null"
}
```

One row per stage, not per run. That is what lets the panel animate the pipeline.

### 1.4 The compression function (D4)

Both tracks implement it; the test vectors below are the acceptance test on both sides.

```js
const compress = (realMin) => 5.1 * Math.log(1 + realMin);        // seconds
const expand   = (demoSec) => Math.exp(demoSec / 5.1) - 1;         // minutes
```

| real_minutes | demo_seconds (1 dp) |
|---|---|
| 0 | 0.0 |
| 1 | 3.5 |
| 20 | 15.5 |
| 120 | 24.5 |
| 43200 | 54.5 |

n8n uses it to set Wait durations. The panel uses it to show "real: 2 h · demo: 24 s" countdowns. If the two disagree, the countdown and the send drift apart on stage.

### 1.5 Branch config block (n8n, one Edit Fields node per branch)

```json
{
  "branch": "A_browse",
  "trigger": ["preview_completed", "title_viewed"],
  "delay_real_min": 120,
  "lane": "ai",
  "message_kind": "marketing",
  "channel_rule": "marketing_default",
  "goal": "purchase previewed or similar title"
}
```

---

## 2. Timeline

### Sat 26 Sep: Contracts and walking skeleton (together, then split)

**Together (first 2 to 3 hours)**
- Agree and commit section 1 as `/docs/contracts.md`.
- Repo, `docker-compose.yml` (n8n, ollama, backend), `.env.example`, tunnel set up.
- **Start the long poles now:** create the Meta app and WhatsApp test number, verify team phones, and submit the utility and marketing templates for approval. Create the Mailtrap sandbox. Pull the Ollama model.

**Frontend track**
- Backend skeleton with seeded data: 15 to 20 real Yakwetu titles in KES, 4 demo users covering the consent matrix (all channels / email only / WhatsApp only / none), one Sheng-language user.
- `/logs` POST and GET working.

**Automations track**
- Webhook, validate required fields, dedupe via backend, log `received`.
- Shared helper Code node: `compress()` plus a `log(stage, ...)` HTTP call.

**Checkpoint (end of day):** a curl to the webhook produces a `received` row visible via `GET /logs`.

### Sun 27 Sep: First branch end to end (B1 Payment rescue)

**Why B1 first:** it needs no LLM, has the shortest delay, and passes through every shared stage (dedupe, wait, re-check, consent, template, channel, send, log). Once B1 works, every other branch is a config block plus its own lane.

**Frontend track**
- Storefront: user picker, title grid, BUY button (calls `/purchases`), "payment fails" button with reason selector.
- Log panel v1: rows grouped by `event_id`, newest first, auto-refresh.

**Automations track**
- Branch router (Switch on event type) feeding the shared pipeline.
- Wait using `compress(delay_real_min)` when `demo_mode`, real minutes otherwise.
- Re-check, consent check, four failure-reason templates, email via Mailtrap.

**Integration test:** pick user, fail payment (STK timeout), see email in Mailtrap within about 4 s, see every stage in the panel. Then repeat but click BUY during the wait: the run must stop at `rechecked` with `already_purchased`.

### Mon 28 Sep: Branch A (AI lane)

**Automations track**
- Candidate builder: same title, same series, same genre, same language, minus owned, max 5.
- Ollama call (`/api/chat`, JSON mode, temperature 0.2) with the allowed selling points in the system prompt.
- Guardrails: id in candidates, 300 characters max, banned-phrase list. Any failure goes to fallback template; log `ai` or `fallback`.
- Measure Ollama latency on the demo laptop. It adds to the 24.5 s wait, so the panel should show an `ai` stage.

**Frontend track**
- Preview and "view title" buttons.
- Panel v2: live countdown per waiting run with dual clock, decision badges (sent / suppressed + reason), full message text, AI vs fallback tag.

**Integration test:** preview 40 STICKS as the English user and as the Sheng user. Force a guardrail failure (a prompt test that returns "hurry") and confirm fallback text is sent and logged.

### Tue 29 Sep: B2 device bridge and the channel router

**Automations track**
- `unsupported_device` path: zero delay, three templates (Android app link, open in Chrome, iOS waitlist). Log iOS as a demand-signal row.
- Channel router per D6: utility goes WhatsApp, then SMS (logged, not sent), then email. Marketing goes email by default, WhatsApp only if `price_kes >= WHATSAPP_MIN_KES`.
- WhatsApp Cloud API send, using the templates approved since Saturday.
- Error Trigger workflow that emails the team and writes an `error` log row.

**Frontend track**
- Device selector at BUY (simulates the Chrome-only modal).
- Consent toggles per demo user, so channel switching can be shown live.

**Integration test:** the same payment failure routes to WhatsApp for the all-consent user and to email for the email-only user. A KES 5 episode never goes to WhatsApp.

### Wed 30 Sep: Add-ons (sign-up rescue, win-back)

**Automations track**
- Sign-up rescue: `auth_abandoned`, 20 min real (15.5 s demo), template with the title from `ref`, email or WhatsApp per D6.
- Win-back: Schedule Trigger every 10 s, `GET /users/inactive?threshold_s=compress(43200)`, emit synthetic `winback_due` into the pipeline (skip wait), AI lane picks an unowned title from `top_genre`. Mark the user so they aren't picked twice.

**Frontend track**
- "Abandon sign-in" flow: BUY while signed out, shows the bare sign-in page, "leave" button fires `auth_abandoned` with `ref`.
- "Set user inactive" button.
- Panel: a scheduler row type so the audience sees the scan find the user.

**Integration test:** all four branches run in one session without restarting anything.

### Thu 1 Oct: Freeze, harden, rehearse

- **Feature freeze at 12:00.** After that, bug fixes only.
- Failure drills: WhatsApp send fails (panel shows `failed`, email fallback still sent); Ollama stopped (fallback template sent); duplicate event (second one logged `duplicate`).
- Write `/docs/demo-script.md`: order of branches, which user for each, what to say during each wait.
- Two full rehearsals with a timer.
- Record a backup video of a clean run in case the venue network fails.
- Export all workflows to `/workflows` and tag the commit `demo-v1`.

### Fri 2 Oct: Present

- Morning: warm up Ollama, start the tunnel, run one smoke test per branch, check Mailtrap and the test phones.

---

## 3. Suggested demo order (about 6 minutes of live action)

1. **B1 Payment rescue** (3.5 s): fastest win, proves the pipeline. Then show the stop-on-purchase case.
2. **B2 Device bridge** (0 s): the biggest site finding, shown as the iOS demand counter.
3. **A Browse recovery** (24.5 s): the AI moment. Talk through the guardrails while the countdown runs.
4. **Sign-up rescue** (15.5 s): shows you studied their real funnel.
5. **Win-back** (54.5 s): start it first and let it land last; proves the compression story.

---

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp template approval is slow or rejected | Submitted Saturday. Email via Mailtrap is the guaranteed channel; the panel proves routing even if WhatsApp fails. |
| Ollama too slow on the laptop | Measure Monday; drop to a smaller model if needed. Fallback template covers timeouts (set a 20 s HTTP timeout). |
| Model writes poor Sheng | Keep the Sheng user for the demo only if Monday's test passes; otherwise fall back to English and say so honestly. |
| Tunnel URL changes on restart | Reserve a fixed URL, or keep the storefront's webhook URL in one env value. |
| Contract drift between tracks | Contracts frozen Sunday; changes need both leads. Integration tests at the end of each day, not just Thursday. |
| Scope creep from the design doc | Deferred list in `decisions.md` section 3 stays deferred until after Thursday's freeze. |
| n8n static data doesn't persist in manual test runs | Dedupe and win-back marking live in the backend, not workflow static data. |

---

## 5. Definition of done for Friday

- [ ] Four branches (A, B with device sub-case, sign-up rescue, win-back) run live from storefront button to delivered message.
- [ ] Every run shows each stage in the panel, including suppressions with reasons.
- [ ] The purchase re-check visibly stops a nudge.
- [ ] AI output is guardrailed and falls back cleanly; the panel says which was used.
- [ ] Channel choice visibly changes with consent and price.
- [ ] Demo mode off gives real timings with no other change (show the config).
- [ ] Backup recording exists.
