#!/bin/sh
# One-command setup for reviewers and for demo day.
#   sh tools/setup.sh        # no GPU needed: the built-in AI stub writes the AI messages
#   sh tools/setup.sh --ai   # real model: starts Ollama (NVIDIA GPU) and pulls qwen2.5:7b (4.7 GB)
set -e
cd "$(dirname "$0")/.."


AI=0
[ "$1" = "--ai" ] && AI=1

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
  if [ "$AI" = "0" ]; then
    sed -i.bak -E 's|^OLLAMA_URL=.*$|OLLAMA_URL=http://backend:3000/mock-ollama|' .env && rm -f .env.bak
    echo "AI lane uses the built-in stub (run with --ai for the real model)"
  fi
fi
if ! grep -qE '^YAK_KEY=.+' .env; then
  KEY=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))" 2>/dev/null || date +%s%N | sha256sum | cut -c1-24)
  if grep -q '^YAK_KEY=' .env; then sed -i.bak -E "s|^YAK_KEY=.*$|YAK_KEY=$KEY|" .env && rm -f .env.bak; else echo "YAK_KEY=$KEY" >> .env; fi
  echo "Generated YAK_KEY in .env"
fi

if [ "$AI" = "1" ]; then
  docker compose --profile ai up -d --build
  echo "Pulling the model (first time only)..."
  docker compose exec -T ollama ollama pull "$(grep -E '^OLLAMA_MODEL=' .env | cut -d= -f2 | tr -d '\r' || echo qwen2.5:7b)"
else
  docker compose up -d --build
fi

echo "Waiting for n8n (first start runs database migrations, can take a few minutes)..."
i=0; until curl -s -o /dev/null http://localhost:5678/healthz; do i=$((i+1)); [ $i -gt 180 ] && { echo "n8n did not start"; exit 1; }; sleep 2; done

# MSYS_NO_PATHCONV: Git Bash on Windows would otherwise rewrite /workflows to a Windows path (set only here: it breaks /dev/null)
MSYS_NO_PATHCONV=1 docker compose exec -T n8n n8n import:workflow --separate --input=/workflows
for id in yakErrorAlerts01 yakPipeline00001 yakWinbackScan01; do
  docker compose exec -T n8n n8n publish:workflow --id=$id >/dev/null
done
docker compose restart n8n >/dev/null

echo "Waiting for the pipeline webhook..."
i=0; until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:5678/webhook/yak/events)" = "200" ]; do
  i=$((i+1)); [ $i -gt 90 ] && { echo "Pipeline webhook not registered"; exit 1; }; sleep 2
done

cat <<MSG

Ready.
  Storefront + live logs:  http://localhost:3000
  Logs, funnel, CSV:       http://localhost:3000/logs
  n8n (workflows):         http://localhost:5678  (create an owner account on first visit)
Smoke test:                node tools/stress.js
MSG
