# Yakwetu Re-Engagement Engine: Demo

Working demo of the scope in `docs/decisions.md`: browse recovery (AI), payment rescue with the unsupported-device sub-case, sign-up rescue and win-back, all running through one n8n pipeline.

```
storefront (localhost:3000) ──> backend /api/events ──> n8n webhook ──> shared pipeline
                                   ▲                                        │
      live engine panel  <── SSE ──┤ logs, context, dedupe, deliver  <──────┘
                                   │
                  n8n win-back scan (every 10 s) ──> /api/events (winback_due)
```

## Run it

Needs Docker and Node 18+ (Node only for the test scripts). No GPU and no accounts needed.

```bash
git clone https://github.com/Kiharal/Invoics_n8n.git && cd Invoics_n8n
sh tools/setup.sh          # built-in AI stub, runs anywhere
sh tools/setup.sh --ai     # real model: Ollama + qwen2.5:7b (NVIDIA GPU, 4.7 GB download)
node tools/stress.js       # smoke test: must end with ALL CHECKS PASSED
```

`setup.sh` creates `.env` (with a random `YAK_KEY`), starts the stack, imports and publishes all three workflows (including `yak-error-alerts`, which n8n 2.x only runs when published) and waits until the pipeline webhook answers. The first start takes a few minutes while n8n migrates its database.

Then open:
- http://localhost:3000: storefront simulator on the left, live engine logs on the right.
- http://localhost:3000/logs: the logs full-page, with the funnel per branch and a CSV export.
- http://localhost:5678: the n8n workflows (create an owner account on first visit to look inside).

All ports are bound to 127.0.0.1, so nobody else on the network can drive the demo. Endpoints n8n uses need the `x-yak-key` header.

With nothing else in `.env`, everything works and deliveries are marked "simulated". Add credentials to go live:

| Channel | Live when | Notes |
|---|---|---|
| Email | `MAILTRAP_API_TOKEN` + `MAILTRAP_TEST_INBOX_ID` (HTTPS, preferred) or `SMTP_*` | `node tools/mailtrap-sandbox.js` finds your sandbox and fills the ids. HTTPS works on networks that block SMTP. Show the Mailtrap inbox on screen |
| WhatsApp | `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `DEMO_PHONE_*` set | Test number only reaches verified phones. Free-form text needs the phone to have messaged the test number within 24 h; otherwise set `WA_TEMPLATE_NAME` |
| SMS | never | Logged only, per D6 |
| AI | `--profile ai` and the model pulled | n8n always calls the model through the backend (`/ai`). The Logs switch "Breaks the rules" / "Times out" swaps in the stub for the next message, on the real stack too, to show the guardrails and the 25 s timeout |

After changing `.env`: `docker compose --profile ai up -d` (or without `--profile ai` on the stub) recreates the containers.

## Demo-day runbook

- `sh tools/setup.sh --ai`, then `curl -X POST -H "x-yak-key: <YAK_KEY>" localhost:3000/api/admin/warm-ai` so the first AI message is not a cold start.
- Clear the Mailtrap sandbox inbox. Load and stress scripts switch real email off; don't run them after clearing.
- Never restart n8n or the backend while runs are waiting: short waits live in memory. The panel marks such runs **Lost** 60 s after their wait ends.
- If a message comes out as the fallback, open the row: the reason is logged. That is the guardrail working, not a failure.

## Demo script (about 6 minutes)

Start win-back first so it lands last.

Keep the storefront and `/logs` open side by side.

1. **Win-back:** On Simulator, open the person menu → Kevo → Quiet 30 days. The new log row opens on its own; countdown starts at 54.5 s.
2. **Payment rescue:** Amina, BUY 40 STICKS. In checkout pay with M-Pesa, pick "Payment does not complete", Pay. Message in 3.5 s. Then repeat and pick "goes through" during the wait on a preview to show the re-check stopping a nudge.
3. **Device bridge:** Brian, set device to "iPhone or iPad", BUY. Close the playback popup. The iPhone counter on Logs goes up.
4. **Browse recovery (AI):** Amina, Preview on THE PRIEST IS DEAD, Leave. Talk through the guardrails during the 24.5 s wait. Then Otieno (no consent: held back) and Wanjiru (WhatsApp only, KUTU is below the price floor, so the engine pitches a title that justifies a paid message).
5. **Sign-up rescue:** untick Signed in, BUY, "Leave this page".
6. **Duplicate:** On Logs, Replay. The row shows it was ignored.
7. **Attribution:** after a nudge arrives, buy that title as the same viewer (stands in for tapping the link, which carries `?nid=`). The purchase row says "from nudge", and `/logs` shows the KES in the funnel. Export CSV for the client's spreadsheet.
8. **Guardrails:** on Logs switch the AI to "Breaks the rules", preview a film: the fallback goes out with the rejection reason. Switch back to "Writes a good message".

## Layout

```
backend/            Express app: platform mock, log store (SSE), delivery adapters, AI stub
backend/public/     Storefront at / and engine logs at /logs
backend/data/       Catalog (real Yakwetu titles) and demo users
workflows/          n8n workflows (generated, importable)
tools/build-workflows.js   Source for the workflows. Edit here, run `node tools/build-workflows.js`
tools/harness.js    Test-only runner that executes the workflow JSON without n8n
tools/stress.js     Fires overlapping scenarios and checks every rule against the log (resets state!)
tools/stress/       Judge audit: functional.js, load.js, chaos.js (stops containers), hostile.js
tools/setup.sh      One-command setup (see Run it)
docs/               decisions.md, roadmap.md, stress-test-report.md, submission.md
```

## Changes from the roadmap contracts

- Storefront events go through `POST /api/events` on the backend, which forwards to n8n. Same origin (no CORS), and the "fired" row is logged even if n8n is down.
- Delivery adapters (Mailtrap HTTPS API or SMTP, WhatsApp Cloud API) live in the backend at `POST /api/deliver`. n8n still decides whether, what and which channel. Credentials stay in one `.env`.
- Win-back scan endpoint is `GET /api/users-inactive` (avoids clashing with `/api/users/:id`).
- The LLM returns `pick_title_id`, `reason`, `message` only. Channel is a cost rule applied in n8n, not a model decision. n8n appends the tracked link, so the model never writes URLs.
- One `GET /api/context` call after the wait returns user, consent, purchase status, catalog and a `profile` (favourite genre from purchases, owned titles, recent activity).
- The model gets a JSON brief: viewer, situation, time of day, and up to 5 candidates, each with its story, cast and a rule-written `why_for_viewer` (previewed it, shares an actor with a film they own, same genre, their language). Ollama `format` is a JSON schema whose `pick_title_id` is an enum of the candidate ids.
- Extra guardrails: the message must name the picked film exactly once and exactly as written; may mention other films only if the viewer owns or recently touched them; must not claim feelings ("you loved") or facts the brief never gave (director, awards, twists, ending); no generic filler ("check it out"), no links, no example leak, and any KES figure must be real. A rejected message gets ONE retry with the rejection reason; after that the fallback template goes out (personal too: name, film, story). A failed or timed-out model call skips the retry.
- Sheng speakers get English with a Sheng greeting: qwen2.5:7b writes poor Sheng.
- Nudge lock: one browse/sign-up nudge per viewer and title, one win-back per viewer, per 24 h real (`compress(1440)` = 37.1 s demo). Utility messages are never locked.
- Final purchase re-check right before delivery (`GET /api/purchase-check`), because the AI call takes seconds.
- The delivery adapter refuses any channel the viewer has not consented to, as a last line of defence.
- Tracking: every consent change is logged with before, after and source. A purchase carrying a nudge id (`nid`) that was really sent to that viewer for that title is credited to the nudge (last click, no holdout). `GET /api/funnel` and `GET /api/export.csv` give the funnel and the raw log.

## Before Friday

- Prices, synopses and cast in `backend/data/catalog.json` were taken from the title pages on 28 Sep 2026. THE PRIEST IS DEAD shows no price on its page: KES 199 is still a placeholder (`price_confirmed: false`).
- Run `node tools/stress.js` against the real stack after any change (24 overlapping events, malformed input, purchase during the wait, duplicate race). It must end with `ALL CHECKS PASSED`.
- Test the real model's Sheng output before keeping Wanjiru in the script.
