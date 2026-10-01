#!/bin/sh
# Prints n8n execution counts by workflow and status (read-only query on n8n's SQLite DB inside the container).
docker compose exec -T n8n node -e '
const sqlite3 = require("/usr/local/lib/node_modules/n8n/node_modules/sqlite3");
const db = new sqlite3.Database("/home/node/.n8n/database.sqlite", sqlite3.OPEN_READONLY);
db.all("select workflowId, status, count(*) n from execution_entity group by workflowId, status", (e, rows) => { console.log(e ? e.message : JSON.stringify(rows)); db.close(); });'
