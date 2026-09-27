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

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec ollama ollama pull qwen2.5:7b      # or set OLLAMA_URL to the stub, see .env.example
docker compose exec n8n n8n import:workflow --separate --input=/workflows
```

1. Open http://localhost:5678, create the owner account.
2. Open **yak-engine-pipeline** and **yak-winback-scan** and activate (publish) both. `yak-error-alerts` does not need activating; check the pipeline's settings list it as the error workflow.
3. Open http://localhost:3000. Simulator is on the left; Logs update live on the right. http://localhost:3000/logs is the same console full-page.

With nothing in `.env`, everything works and deliveries are marked "simulated". Add credentials to go live:

| Channel | Live when | Notes |
|---|---|---|
| Email | `SMTP_*` set (Mailtrap Email Sandbox) | Show the Mailtrap inbox on screen |
| WhatsApp | `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `DEMO_PHONE_*` set | Test number only reaches verified phones. Free-form text needs the phone to have messaged the test number within 24 h; otherwise set `WA_TEMPLATE_NAME` |
| SMS | never | Logged only, per D6 |
| AI | Ollama running with the model pulled | `OLLAMA_URL=http://backend:3000/mock-ollama` uses the stub; Logs can switch the stub to "breaks the rules" or "times out" to show the guardrails |

After changing `.env`: `docker compose up -d` (recreates containers).

## Demo script (about 6 minutes)

Start win-back first so it lands last.

Keep the storefront and `/logs` open side by side.

1. **Win-back:** On Simulator, open the person menu → Kevo → Quiet 30 days. The new log row opens on its own; countdown starts at 54.5 s.
2. **Payment rescue:** Amina, BUY 40 STICKS. In checkout pick "M-Pesa prompt times out", Pay. Message in 3.5 s. Then repeat and pick "goes through" during the wait on a preview to show the re-check stopping a nudge.
3. **Device bridge:** Brian, set device to "iPhone or iPad", BUY. Close the playback popup. The iPhone counter on Logs goes up.
4. **Browse recovery (AI):** Amina, Preview on THE PRIEST IS DEAD, Leave. Talk through the guardrails during the 24.5 s wait. Then Otieno (no consent: held back) and Wanjiru (WhatsApp only, KUTU is below the price floor, so the engine pitches a title that justifies a paid message).
5. **Sign-up rescue:** untick Signed in, BUY, "Leave this page".
6. **Duplicate:** On Logs, Replay. The row shows it was ignored.

## Layout

```
backend/            Express app: platform mock, log store (SSE), delivery adapters, AI stub
backend/public/     Storefront at / and engine logs at /logs
backend/data/       Catalog (real Yakwetu titles) and demo users
workflows/          n8n workflows (generated, importable)
tools/build-workflows.js   Source for the workflows. Edit here, run `node tools/build-workflows.js`
tools/harness.js    Test-only runner that executes the workflow JSON without n8n
docs/               decisions.md, roadmap.md, contracts
```

## Changes from the roadmap contracts

- Storefront events go through `POST /api/events` on the backend, which forwards to n8n. Same origin (no CORS), and the "fired" row is logged even if n8n is down.
- Delivery adapters (Mailtrap SMTP, WhatsApp Cloud API) live in the backend at `POST /api/deliver`. n8n still decides whether, what and which channel. Credentials stay in one `.env`.
- Win-back scan endpoint is `GET /api/users-inactive` (avoids clashing with `/api/users/:id`).
- The LLM returns `pick_title_id`, `reason`, `message` only. Channel is a cost rule applied in n8n, not a model decision. n8n appends the tracked link, so the model never writes URLs.
- One `GET /api/context` call after the wait returns user, consent, purchase status and catalog.

## Before Friday

- **KES prices in `backend/data/catalog.json` are placeholders** in the KES 5 to 199 range. Replace with the prices shown on the site.
- The workflow JSON was checked against the node definitions in n8n-nodes-base 2.15.1 and the logic was tested end to end with `tools/harness.js`, but it has not been imported into a running n8n yet. Import and run the demo script once today.
- Test the real model's Sheng output before keeping Wanjiru in the script.
