# Yakwetu Re-Engagement Engine: Stress Test and Judge Audit

Audit run on Tue 29 Sep 2026 against the live Docker stack (backend :3000, n8n 2.40.7 :5678, Ollama qwen2.5:7b on an RTX 2060 6 GB), commit `a0a4f69`. No application code, workflow or generator was changed during the audit. Test scripts are in `tools/stress/`, raw results in `tools/stress/out/`.

---

## 1. Verdict

The engine does what the demo promises when nothing around it fails. All five branches, the purchase re-check, consent read after the wait, the price floor and dedupe passed on the real stack, and it lost 0 of 400 load-test events.

It is **not demo-ready as configured**. The single biggest risk: **every port is open on the venue network with no key set**. Anyone on the same Wi-Fi can reset the demo, flip consent, forge "sent" rows or push text through the delivery adapter in the middle of the talk.

Close behind:
- The guardrail drill in the README ("Breaks the rules" / "Times out") has no effect on the Docker stack.
- Email, the "guaranteed channel", cannot leave this network over SMTP.
- The error-alert workflow never runs, so a workflow failure leaves no trace on the panel.

### Status after fixes (same day, Tue 29 Sep)

Every DEMO-BREAKER and every JUDGE-VISIBLE gap that needed code is fixed and re-tested on the live stack.

Re-test results:
- `tools/stress.js`: ALL CHECKS PASSED.
- `tools/stress/functional.js`: 23 of 24 passed. The one fail was the F1c test bug; its title was fixed afterwards and not re-run.
- `tools/stress/hostile.js`: 5 of 5 passed.
- A clean clone with no `.env` and no GPU passed `sh tools/setup.sh` and then `node tools/stress.js`.

| Gap | Fix | Verified by |
|---|---|---|
| G1 open ports, no key | All ports bound to `127.0.0.1`. `YAK_KEY` is set, and `setup.sh` generates one. | LAN IP 3000/5678/11434 refused. `/api/deliver` without the key returns 401 (C7d). A forged `/api/logs` row returns 401 (C7c). |
| G2 guardrail drill dead on Docker | n8n calls the model through the backend (`/ai`). "Breaks the rules" and "Times out" swap in the stub. Model timeout is 25 s; the slow stub takes 30 s. | F10b: fallback `banned_phrase: Hurry`. F10s: fallback `timeout of 25000ms exceeded`. Both on the real stack. |
| G3 SMTP blocked | Email goes through Mailtrap's HTTPS Sandbox API. SMTP is kept as the alternative. | F12: `delivery=live`, message "Your payment for KIZINGO did not go through" found in the sandbox inbox for brian@demo.yakwetu.test. |
| G4 error workflow inactive | `setup.sh` publishes `yak-error-alerts`; README fixed. | n8n reports 3 published workflows, and the "not active" error is gone. A workflow error was not induced after the fix, so the error row landing on the panel is UNVERIFIED. |
| G5 lost runs shown as "Waiting" forever | The panel marks a run **Lost** 60 s after its wait ends with no decision, and explains why. | Panel code run on a stale run: `lost`. Fresh run: `waiting`. |
| G6 XSS via `event_id` | The backend accepts only `[A-Za-z0-9._:-]{1,64}` (400 otherwise). The panel escapes the key. | C7a: HTTP 400; a forged row carrying the payload renders escaped. |
| G7 no attribution | A purchase with a `nid` that was really sent to that viewer for that title is credited (last click), with revenue. The storefront passes the `nid` of the last nudge it showed. | F13: attributed, KES 49 on stats and funnel; someone else's `nid` is not credited. |
| G8 no funnel or export | `GET /api/funnel` (per branch: runs, held back by reason, sent by channel, purchases, KES) and `GET /api/export.csv`. Funnel table and export link on `/logs`. | F13: funnel B_payment 1 purchase KES 49; CSV has the rows. |
| G9 no consent evidence | A `consent_changed` row with before, after and source, shown as a note on the panel. | F14. |
| G11 scan floods executions | The win-back scan no longer saves successful executions. | Generator setting `saveDataSuccessExecution: 'none'`. |
| G20 tests burn the email quota | `stress.js`, `load.js`, `functional.js` and `chaos.js` switch real email off after every reset (`POST /api/admin/email`). | F12 switches it on for one message, then off. |
| Reviewers without a GPU | Ollama is behind the `ai` compose profile. `setup.sh` defaults to the stub. | Clean copy: setup finished, then `stress.js` ALL CHECKS PASSED on the stub. |

Still open, by design: G10 (guardrail rejection rate, a talking point) and G12–G19 (PRODUCTION-ONLY).

## 2. Scorecard

| Phase | Grade | Justification |
|---|---|---|
| 1 Recon | n/a | Architecture and assumptions mapped below (appendix A). |
| 2 Functional truth | **A-** | 18 of 19 tests passed first time; the one fail was a test bug (buyer already owned the title) and passed on rerun. Waits land within 0.1 s of D4. |
| 3 Load | **B** | 400 of 400 events completed, 0 lost, 0 workflow errors. The AI lane saturates at about 5 concurrent requests (60 s timeouts, 50% fallback). |
| 4 Chaos | **C** | Ollama outage, malformed input and a 20× duplicate storm are handled well. Restarting n8n loses every run in its Wait node, and restarting the backend loses all state. Errors are invisible because the error workflow is inactive. |
| 5 Security and compliance | **D** | `YAK_KEY` is empty, all three services listen on the LAN, the n8n webhook takes unauthenticated events, and there is a stored XSS in the panel. Consent changes are not recorded and there is no opt-out path. |
| 6 Tracking and proof | **C-** | Every stage is logged with a reason, which is strong. But a purchase is never tied back to the nudge (`nid` is dropped), clicks are not tracked, and there is no per-branch funnel, holdout or export. |
| 7 Q&A readiness | **C+** | 9 STRONG, 8 SHAKY, 3 NO ANSWER (section 6). |

## 3. Gap register

Severity: **DEMO-BREAKER** = can fail live on Friday. **JUDGE-VISIBLE** = works, but a technical judge will spot it. **PRODUCTION-ONLY** = say it as a roadmap point, don't fix.

| ID | Finding | Evidence | Severity | Fix | Effort (h) | Owner | Deadline |
|---|---|---|---|---|---|---|---|
| G1 | Backend, n8n and Ollama listen on all interfaces and `YAK_KEY` is empty. Anyone on the venue Wi-Fi can reset the demo, flip consent, forge log rows and call `/api/deliver`. | `192.168.0.100:3000/5678/11434` all return 200; the firewall rule "Docker Desktop Backend" allows any port on the Public profile; C7c and C7d (appendix B) | DEMO-BREAKER | Bind every port to `127.0.0.1` in `docker-compose.yml`, and set `YAK_KEY` in `.env` so n8n-only endpoints need the header. | 0.5 | both | Tue 29 |
| G2 | The panel's AI stub dropdown ("Breaks the rules", "Times out") only drives `/mock-ollama`. The Docker n8n calls real Ollama, so the README's guardrail drill does nothing. "Times out" also doesn't time out: the stub sleeps 25 s and the HTTP timeout is 60 s. | Harness run: `slow` gives source `ai` after 49.7 s; `.env` has `OLLAMA_URL=http://ollama:11434` | DEMO-BREAKER | Route n8n's model calls through a backend proxy (`/ai/api/chat`). Mode `good` forwards to real Ollama; `bad` and `slow` use the stub. Set the model timeout to 25 s and make the slow stub sleep 30 s. | 1 | both | Tue 29 |
| G3 | Outbound SMTP is blocked on this network: ports 25, 465, 587 and 2525 all time out, from the host and the container. With SMTP set, every email nudge fails. Venue networks often block SMTP too. | `connect ECONNREFUSED 54.158.84.126:2525`, then timeouts on every port; HTTPS to mailtrap.io works | DEMO-BREAKER | Send email through Mailtrap's HTTPS Sandbox API (`sandbox.api.mailtrap.io`) when `MAILTRAP_API_TOKEN` and `MAILTRAP_TEST_INBOX_ID` are set; keep SMTP as the alternative. | 1 | frontend (backend) | Tue 29 |
| G4 | The error workflow is never executed. n8n 2.x runs an error workflow only if it is published, and the README says it needn't be. A workflow error leaves no row on the panel. | n8n log: `Workflow "yakErrorAlerts01" is not active and cannot be executed` | DEMO-BREAKER | Publish `yak-error-alerts` in the import step, and fix the README and `tools/` import instructions. | 0.25 | automations | Tue 29 |
| G5 | Restarting n8n drops every run sitting in a Wait node: 0 of 4 resumed. The panel shows them as "Waiting" forever with a finished countdown. | C3 | JUDGE-VISIBLE | Demo runbook: never restart n8n mid-demo. The panel marks a run "Lost" when no decision arrives 60 s after its wait ends, so a failure is visible instead of silent. | 1 | frontend | Wed 30 |
| G6 | Stored XSS on the panel: a caller-chosen `event_id` is written raw into the `data-key` attribute. | C7a: `data-key="evt"><img src=x onerror=alert(1)>#1"` | JUDGE-VISIBLE | Escape `item.key` in `common.js`, and have the backend accept only `event_id` matching `[A-Za-z0-9._:-]{1,64}`. | 0.25 | both | Tue 29 |
| G7 | A purchase is never attributed to the nudge. The storefront does not send `nid`, so the `purchased` row has `nudge_id: null`. There is no attributed revenue anywhere. | `store.js:103` posts only `user_id` and `title_id` | JUDGE-VISIBLE | Backend last-touch attribution: on purchase, link the most recent `sent` nudge for the same user and title (or an explicit `nid`) within the 7-day real window, compressed by D4. Log `nudge_id`, branch, channel and KES. | 1 | frontend (backend) | Wed 30 |
| G8 | There is no funnel per branch and channel (events, sent, suppressed by reason, purchases, revenue), and no export. The panel shows four global counters. | `/api/stats` returns totals only | JUDGE-VISIBLE | Add `GET /api/funnel` (per branch × channel) and `GET /api/export.csv`, plus a funnel table on `/logs` with an export link. | 1.5 | both | Wed 30 |
| G9 | Consent changes leave no record, so there is no evidence of when or how consent was given or withdrawn. | No `addLog` on `/api/users/:id/consent` | JUDGE-VISIBLE | Log a `consent_changed` row with before, after, source and timestamp; the panel shows it as a note. | 0.25 | frontend (backend) | Wed 30 |
| G10 | The real model's guardrail rejection rate is high: 20–30% of AI-lane sends go out as fallback when idle, mostly "names another title", "claims a feeling" and "repeats the title". | Steady run: 9 AI and 3 fallback; functional F3c "rejected twice: claims_a_feeling: loved" | JUDGE-VISIBLE | No code change. Talking point: the guardrails are doing their job, and every rejection is logged with the reason. Rehearse with Amina (AI accepted every time in testing). | 0 | automations | — |
| G11 | The win-back scan stores an n8n execution every 10 s (1,930 in about a day), which floods the executions list a judge may open. | `tools/stress/n8n-exec-count.sh` | JUDGE-VISIBLE | Set `saveDataSuccessExecution: 'none'` on the scan workflow; errors are still saved. | 0.1 | automations | Wed 30 |
| G12 | The AI lane handles about 5 concurrent requests. At 30 at once, p50 fired-to-sent is 87 s and 8 of 20 sends fall back on the 60 s timeout. The 7B model is split 18% CPU / 82% GPU on 6 GB of VRAM. | burst-ai-30; `ollama ps` | PRODUCTION-ONLY | Talking point (section 5). | — | — | — |
| G13 | All state is in memory. A backend restart loses consent changes, purchases, logs, the dedupe set and locks, and a replayed event is sent again. | C4 | PRODUCTION-ONLY | Talking point. Runbook: don't restart the backend during the demo. | — | — | — |
| G14 | The n8n webhook accepts unauthenticated events and bypasses the backend's validation. After G1 this is only reachable from localhost. | M12 | PRODUCTION-ONLY | Talking point (header auth on the webhook). | — | — | — |
| G15 | If the backend is down when a wait ends, the run fails inside n8n and nothing reaches the panel (the error workflow also posts to the backend). | C2b: 0 rows, n8n error count +1 | PRODUCTION-ONLY | Talking point (durable queue and a dead-letter store). | — | — | — |
| G16 | No link click tracking. Links carry `utm_*` and `nid` to www.yakwetu.africa, but the engine never sees the click. | No redirect endpoint | PRODUCTION-ONLY | Talking point (GA4 reads the UTM and `nid` the engine already adds). | — | — | — |
| G17 | No opt-out handling (STOP reply, unsubscribe link). | No code path | PRODUCTION-ONLY | Talking point. | — | — | — |
| G18 | No holdout group, so the engine proves attributed revenue, not lift. | Deferred in decisions §3 | PRODUCTION-ONLY | Talking point. | — | — | — |
| G19 | Under a 200-event burst, `/api/events` holds each request until n8n acknowledges it (POST p50 6.1 s). | burst-200 | PRODUCTION-ONLY | Talking point (queue in front of n8n). | — | — | — |
| G20 | The Mailtrap free plan allows one sandbox, shared with the existing "My Sandbox" inbox (1 older message). The free-plan monthly send quota is UNVERIFIED. | `mailtrap-sandbox.js`: `You've reached the sandboxes limit` | JUDGE-VISIBLE | Load and stress runs must keep email off (they now default to it). Clear the inbox before the demo. | 0.1 | both | Thu 1 |

## 4. Fix plan by day

Mon 28 Sep has passed (the audit ran Tue 29). Feature freeze is Thu 1 Oct 12:00.

**Tue 29 Sep (today): demo-breakers first**
- G1: bind ports to localhost and set `YAK_KEY`. (both)
- G2: AI proxy so the guardrail drill works on the real stack; fix the timeout. (both)
- G3: email over Mailtrap's HTTPS API. (frontend, backend)
- G4: publish the error workflow; fix the docs. (automations)
- G6: panel escaping and `event_id` validation. (both)
- Re-run `tools/stress.js`, `tools/stress/functional.js` and `tools/stress/chaos.js`.

**Wed 30 Sep: judge-visible gaps**
- G7: last-touch attribution with revenue. (frontend, backend)
- G8: funnel endpoint, CSV export and funnel table on `/logs`. (both)
- G9: consent evidence rows. (frontend, backend)
- G5: "Lost" status for stalled runs. (frontend)
- G11: stop saving win-back scan executions. (automations)

**Thu 1 Oct (freeze 12:00)**
- Morning: two timed rehearsals, clear the Mailtrap inbox, warm the model, record the backup video.
- After 12:00: bug fixes only. Tag `demo-v1`.

**Fri 2 Oct**
- Runbook: `docker compose up -d`, publish check, `POST /api/admin/warm-ai`, one smoke test per branch.
- Never restart n8n or the backend while runs are in flight.

## 5. Talking points for PRODUCTION-ONLY gaps

- **G12 (AI throughput):** "On one laptop GPU the AI lane handles about five nudges at once; real traffic is spread over hours by the delays, and 10,000 abandoned carts a month is about 14 an hour, far below that. Production moves the model to a GPU server or a hosted API behind a queue."
- **G13 (in-memory state):** "The demo backend keeps state in memory so it resets in one click; production replaces it with a database for consent, purchases, dedupe and the log."
- **G14 (webhook auth):** "On stage everything is bound to localhost; in production the n8n webhook takes a signed header from the platform and nothing else."
- **G15 (backend down mid-run):** "If the platform API is down when a wait ends, today the run fails inside n8n; production puts a durable queue and a dead-letter list in front of it, so no nudge disappears silently."
- **G16 (click tracking):** "Every link already carries UTM tags and a nudge id; Yakwetu's GA4 sees the click, and the purchase is tied back by the same id."
- **G17 (opt-out):** "Opt-out is enforced at send time because consent is read fresh after every wait; the STOP keyword and unsubscribe link are the next step and simply set that same flag."
- **G18 (holdout):** "Today we prove attributed revenue; the next step is a 10% holdout per branch to measure true lift."
- **G19 (ingest latency):** "Under a 200-event burst nothing was lost, but the platform waits for n8n to accept each event; production puts a queue in between."

## 6. Judge Q&A

| # | Question | Best honest answer today | Grade |
|---|---|---|---|
| 1 | What happens to runs in a Wait node if n8n restarts? | They are lost: short waits live in n8n's memory (C3, 0 of 4 resumed). Production uses real delays of minutes to days, which n8n persists to its database; for the demo we don't restart. | SHAKY |
| 2 | How many events can this handle? | We fired 400 in load tests, including 200 at once, and lost none. Template branches stay under 11 s p50 at 200 at once. The AI lane handles about 5 concurrent requests on this GPU. 10,000 carts a month is about 14 an hour. | STRONG |
| 3 | What stops a customer getting a nudge after they already bought? | Two re-checks: after the wait (F5 stopped the nudge) and right before delivery (Final re-check node). | STRONG |
| 4 | How do you know the AI isn't making things up? | It can only pick from rule-built candidates via a JSON schema, and guardrails reject invented feelings, crew facts, other titles, wrong prices and urgency. 20–30% of real-model messages are rejected and replaced by a logged fallback. | STRONG |
| 5 | What if the model is down? | Tested (C1): the fallback template goes out and the log says `model call failed: ENOTFOUND ollama`. | STRONG |
| 6 | Show me a guardrail rejection live. | After G2, the "Breaks the rules" switch forces it on the real stack. Before G2, we can't show it on the Docker stack. | SHAKY until G2 ships |
| 7 | How much does this cost per message? | Utility on WhatsApp, marketing on email unless the title is KES 149 or more (D6), SMS logged only. Per-message WhatsApp pricing is not in the repo. | SHAKY |
| 8 | Is consent enforced, and can you prove it? | Enforced: read fresh after the wait (F6a, F6b), and the delivery adapter refuses channels without consent. Proof: after G9, every consent change is a timestamped row. Before that, no record exists. | SHAKY until G9 ships |
| 9 | How does a customer opt out? | Setting their consent flags stops the next send (F6b). A STOP keyword and unsubscribe link are not built. | NO ANSWER |
| 10 | Which purchases did the engine cause? | After G7: purchases within the window of a sent nudge are attributed (last touch) with KES. There is no holdout, so it is attributed revenue, not proven lift. | SHAKY until G7 ships |
| 11 | Are clicks tracked? | Links carry UTM and `nid`; the engine does not see clicks itself. | NO ANSWER |
| 12 | Can the client get this data into GA4 or a spreadsheet? | After G8: a CSV export per event and a funnel endpoint. GA4 gets UTM and `nid` on every link. | SHAKY until G8 ships |
| 13 | Who can reach these endpoints? | After G1: localhost only, and n8n-facing endpoints need `x-yak-key`. Today: anyone on the network. | STRONG after G1 |
| 14 | What personal data do you log, and for how long? | Names, the message text, the channel and the email/phone lookup key. It is in memory and gone on restart. There is no retention policy for production yet. | SHAKY |
| 15 | Why n8n and not code? | The shared pipeline, delays and retries are visible and editable by the client team. A branch is a config block (D1), and six branches share one workflow. | STRONG |
| 16 | What is real and what is simulated? | Real: n8n, the Ollama model, guardrails, waits and routing, plus email to a Mailtrap sandbox after G3. Simulated: Yakwetu's platform (catalog prices are from the live site), WhatsApp (no credentials) and SMS (logged by design). | STRONG |
| 17 | Why are demo waits seconds long? | Logarithmic compression, one function, `5.1·ln(1+min)`. We measured waits within 0.1 s of the table; demo mode off gives real timing. | STRONG |
| 18 | What happens with a duplicate or replayed event? | 20 concurrent copies gave exactly 1 send and 19 duplicates (C8). A backend restart clears the dedupe set (C4). | STRONG |
| 19 | How would you know if it's broken in production? | After G4, workflow errors land on the panel. There is no alerting to a person, and no metrics or uptime checks. | NO ANSWER |
| 20 | Kenya Data Protection Act? | Consent-first routing and minimal data in events (consent is looked up, not carried). Consent evidence (G9) is shipping. Opt-out, retention and a DPIA are production work. | SHAKY |

## 7. Appendix

### A. Architecture and assumptions (Phase 1)

**Entry points:**
- Backend (Express, :3000): `POST /api/events` (storefront), `POST /api/purchases`, `POST /api/users/:id/consent`, `POST /api/users/:id/inactive`, `POST /api/admin/reset`, `POST /api/admin/ai-stub-mode`.
- Behind `x-yak-key` (open while `YAK_KEY` is empty): `GET /api/context`, `GET /api/purchase-check`, `POST /api/locks`, `POST /api/dedupe`, `POST /api/logs`, `POST /api/deliver`, `GET /api/users-inactive`.
- n8n webhook `POST /webhook/yak/events` (:5678). Ollama `/api/chat` (:11434).

**External calls:**
- Backend to n8n webhook (no timeout).
- n8n to the backend: 10 s timeouts; `Context` continues on fail; `Deliver` 20 s and fails the run.
- n8n to Ollama: 60 s timeout, continue on fail, at most 2 calls.
- Backend to SMTP and to the WhatsApp Graph API.

**State:**
- Backend memory: users and consent, purchases, dedupe set, locks, logs, stats.
- n8n SQLite: executions; waits under 65 s held in process memory.
- Browser `sessionStorage`: selected user, device, signed-in flags.

**Retries:** one model retry after a guardrail rejection. None for HTTP or delivery.

**Assumptions (the attack surface):**
1. The backend is reachable at the end of every wait and at delivery.
2. n8n is not restarted while runs wait.
3. Only trusted clients reach the ports.
4. `event_id` is a well-formed UUID.
5. One model request at a time finishes well inside 60 s.
6. The error workflow runs.
7. SMTP can leave the network.

Load and chaos tests broke assumptions 2, 3, 4, 5, 6 and 7. Assumption 1 was broken in C2b.

### B. Test log

Each row: what was run, expected, actual, evidence. Commands: `node tools/stress/functional.js`, `node tools/stress/chaos.js <group>`, `node tools/stress/hostile.js`, `node tools/stress/load.js ...`. Full output is in `tools/stress/out/*.json`.

**Phase 2: functional (real stack: n8n and qwen2.5:7b)**

| ID | Test | Expected | Actual | Result |
|---|---|---|---|---|
| F1a | M-Pesa not completed (Amina) | WhatsApp, names method, no promotion, 3.5 s wait | whatsapp [template], wait 3.6 s | PASS |
| F1b | Bonga not completed (Brian) | email | email [template], wait 3.6 s | PASS |
| F1c | Visa declined (Kevo, TEKA) | WhatsApp "Your Visa card was declined" | first run used a title Kevo owns (correctly suppressed `already_purchased`); rerun on TEKA sent via WhatsApp | PASS (rerun) |
| F1d | Mastercard declined (Amina) | WhatsApp | whatsapp [template] | PASS |
| F2 | Device: android, desktop_non_chrome, ios | platform text, about 0 s | sent in 0.4, 0.6 and 0.5 s; counters ios=1, android=1, desktop=1 | PASS |
| F3a | Browse, Amina, THE PRIEST IS DEAD (KES 199) | sent, AI or fallback with reason, 24.5 s wait | whatsapp [ai], wait 24.6 s, model 6.1 s | PASS |
| F3b | Browse, Brian (email only), JONAROBI | as above | email [ai], wait 24.6 s, model 11.9 s | PASS |
| F3c | Browse, Wanjiru (WhatsApp only), KUTU KES 49 | WhatsApp pitch of a title at or above KES 149 | CARDS ON THE TABLE (KES 149) via WhatsApp [fallback: rejected twice, `claims_a_feeling: loved`] | PASS |
| F3d | Browse, Otieno (no consent) | suppressed `no_consent` | suppressed `no_consent` | PASS |
| F4 | Sign-up rescue, Amina | email, 15.5 s | email [template], wait 15.6 s | PASS |
| F5 | Purchase during the 24.5 s wait | suppressed `already_purchased` at the gate | as expected | PASS |
| F6a | Consent flipped during the wait (Amina WhatsApp off) | utility falls back to SMS | sent via sms | PASS |
| F6b | All consent removed during the wait (Kevo) | `no_consent` | `no_consent` | PASS |
| F7 | Marketing channel rule over all AI sends | WhatsApp only if consent and price at or above 149 | amina:199 WhatsApp, brian:99 email, wanjiru:149 WhatsApp | PASS |
| F8 | Win-back (Kevo) | fired at 54.5 s plus at most 10 s scan, then sent | fired at 58.8 s, sent WhatsApp [ai] | PASS |
| F9 | Duplicate `event_id` (sequential) | 1 duplicate, 1 sent | 1 and 1 | PASS |
| F10 | Guardrail stub modes (harness, stub) | good gives ai; bad gives fallback with reason; slow gives fallback (timeout) | good: ai (25.2 s); bad: fallback "rejected twice: banned_phrase: Hurry" (24.6 s); **slow: ai after 49.7 s, no timeout** | FAIL (G2) |
| F11 | Panel countdown vs n8n wait | same value | the panel's clock reads `demo_delay_s` from the same `waiting` row that n8n uses for the Wait node (`common.js` `runDetail`) | PASS |

**Phase 4: chaos**

| ID | Test | Expected | Actual | Result |
|---|---|---|---|---|
| C1 | `docker compose stop ollama` 5 s into a browse wait | fallback with reason | fallback, reason `model call failed: getaddrinfo ENOTFOUND ollama` | PASS |
| C2 | Backend stopped 11 s during a 15.5 s wait, then started | run completes | `checked` and `sent` arrive, but the earlier `fired` and `waiting` rows are gone (memory wiped) | PASS (partial) |
| C2b | Backend down when a 3.5 s wait ends | error visible | 0 rows on the panel; n8n execution count error +1 (nobody sees it) | FAIL (G4, G15) |
| C3 | `docker compose restart n8n` with 4 runs waiting | runs resume | 0 of 4 finished; restart took 20 s; the webhook works again afterwards | FAIL (G5) |
| C4 | Backend restart | state survives | logs 6 to 0; consent back to seed; purchase gone; a replayed `event_id` is sent again | FAIL (G13) |
| C5 | Pipeline unpublished, event fired | 502 plus a visible row | first attempt raced the restart; rerun: HTTP 502, row `failed:n8n_unreachable (n8n answered 404)` | PASS |
| M1–M4 | Missing event, unknown user, unknown title, numeric `user_id` | 4xx | 400 each | PASS |
| M5–M7 | String context, array event, unknown event | handled and logged | 200; string context and array event were sent (array coerces to the key), unknown event suppressed `invalid_event`; 0 workflow errors | PASS |
| M8, M11 | 1 MB and 2 MB bodies | 413 | 413 and 413 | PASS |
| M9 | Invalid JSON | 400 | 400 | PASS |
| M12 | Event posted straight to the n8n webhook | rejected | HTTP 200, run executed with no `fired` row | FAIL (G14) |
| C7a | HTML in `event_id` | escaped | raw in the `data-key` attribute | FAIL (G6) |
| C7b | `<script>` in `context.platform` | escaped | escaped | PASS |
| C7c | Forged row via `POST /api/logs` | 401 | 200, shown on the panel | FAIL (G1) |
| C7d | Arbitrary text via `POST /api/deliver` | 401 | 200 "simulated"; with WhatsApp credentials it would send | FAIL (G1) |
| C7e | Can request data reach the LLM prompt? | no | no: the brief is built only from seed users, the catalog and the profile | PASS |
| C8 | Same `event_id` ×20 concurrently | 1 sent, 19 duplicate | fired 20, duplicate 19, sent 1 | PASS |
| C9 | Clock and timezone | no local-time dependency | backend UTC, n8n EAT; waits are relative; `daypart` pinned to Africa/Nairobi; panel formats in browser local time | PASS |
| S1 | LAN exposure | localhost only | 3000, 5678 and 11434 answer on 192.168.0.100 | FAIL (G1) |
| S2 | SMTP egress to Mailtrap | connects | 25, 465, 587 and 2525 time out; HTTPS works | FAIL (G3) |
| S3 | Error workflow | runs on error | `yakErrorAlerts01 is not active and cannot be executed` | FAIL (G4) |
| S4 | `.env` committed? | never | never; no secret-like strings tracked | PASS |

### C. Load test numbers (Phase 3)

Mix: payment 2 : device 1 : signup 1 : browse 1 (burst-ai-30 is browse only). Email and WhatsApp were simulated. n8n pipeline executions matched fired events exactly: +120, +50, +200.

| Run | Fired | Completed | Lost | POST p50/p95 ms | Fired to sent p50 / p95 / max s | Per-branch p50 s | AI / fallback | Error rows | Peak memory (backend / n8n / ollama) |
|---|---|---|---|---|---|---|---|---|---|
| Steady 1/s × 120 s | 120 | 120 | 0 | 53 / 190 | 3.8 / 34.3 / 43.8 | payment 3.8, device 0.3, browse 32.8 | 9 / 3 (rejected twice) | 0 | 29 MB / 627 MB / 1.7 GB |
| Burst 50 | 50 | 50 | 0 | 3,309 / 4,921 | 7.6 / 63.8 / 68.2 | payment 7.1, device 3.2, signup 18.1, browse 49.8 | 5 / 2 | 0 | 22 MB / 870 MB / 1.9 GB |
| Burst 200 | 200 | 200 | 0 | 6,138 / 7,167 | 10.2 / 91.3 / 118.5 | payment 10.0, device 6.7, signup 21.8, browse 91.0 | 7 / 12 (7 timeouts) | 0 | 70 MB / 1.7 GB / 1.9 GB |
| AI burst 30 (real model) | 30 | 30 | 0 | 1,704 / 2,455 | 87.4 / 102.3 / 102.3 | browse 87.4 | 10 / 10 (8 timeouts) | 0 | 33 MB / 783 MB / 2.1 GB |

In the steady run, all sign-ups went to Otieno (no consent) because of a user-rotation bug in `load.js`, fixed before the bursts. The steady run's sign-up latency is therefore empty.

**Where it degrades:**
- The template lanes absorb 200 at once with every run finishing, and payment p50 rises from 3.8 to 10 s. That cost comes from n8n taking in the burst (n8n CPU 266% in the first 15 s).
- The AI lane degrades above about 5 concurrent requests. Ollama serves one request at a time at about 600% CPU, because the model does not fit fully in 6 GB of VRAM (18% CPU / 82% GPU). The queue passes the 60 s timeout and half the messages fall back.

**Supported throughput:**
- About 8 events/s ingest for template branches.
- About 5 to 10 AI messages per minute when requests are spread out.
- The brief's 10,000 abandoned carts a month is about 330 a day, or 14 an hour. That is under 1% of the template capacity. For the AI lane it is about 3 to 5% of capacity (300 to 600 messages an hour) even if every cart used AI, and real delays (2 h, 30 days) spread the load further.
