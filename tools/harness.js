// Test-only: executes the generated workflow JSON with a tiny interpreter for the node types we use.
// Lets us verify the pipeline logic against the real backend before n8n is available.
const http = require('http');
const fs = require('fs');
const path = require('path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'yak-engine-pipeline.json')));
const env = { BACKEND_URL: process.env.BACKEND_URL, YAK_KEY: process.env.YAK_KEY || '', OLLAMA_URL: process.env.OLLAMA_URL, WHATSAPP_MIN_KES: '149' };
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

function evalExpr(str, ctx) {
  if (typeof str !== 'string' || !str.startsWith('=')) return str;
  const s = str.slice(1);
  const whole = s.match(/^\{\{([\s\S]*)\}\}$/);
  const run = (code) => Function('$', '$json', '$env', `return (${code});`)(ctx.$, ctx.$json, env);
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, code) => String(run(code)));
}

async function runNode(node, input, outputs) {
  const $ = (name) => ({ first: () => ({ json: outputs[name][0] }), item: { json: outputs[name][0] } });
  const ctx = { $, $json: input[0] };
  const p = node.parameters;
  switch (node.type) {
    case 'n8n-nodes-base.code': {
      const fn = new (Object.getPrototypeOf(async function () {}).constructor)('$', '$json', '$input', '$env', p.jsCode);
      const res = await fn($, input[0], { first: () => ({ json: input[0] }), all: () => input.map((j) => ({ json: j })) }, env);
      return [res.map((r) => r.json)];
    }
    case 'n8n-nodes-base.httpRequest': {
      const url = evalExpr(p.url, ctx);
      const headers = { 'Content-Type': 'application/json' };
      (p.headerParameters ? p.headerParameters.parameters : []).forEach((h) => { headers[h.name] = evalExpr(h.value, ctx); });
      try {
        const r = await fetch(url, { method: p.method || 'GET', headers, body: p.sendBody ? evalExpr(p.jsonBody, ctx) : undefined, signal: AbortSignal.timeout(p.options.timeout || 10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        return [Array.isArray(j) ? j : [j]];
      } catch (e) {
        if (node.onError === 'continueRegularOutput') return [[{ error: e.message }]];
        throw new Error(`${node.name}: ${e.message}`);
      }
    }
    case 'n8n-nodes-base.if': {
      const c = p.conditions.conditions[0];
      const v = evalExpr(c.leftValue, ctx);
      return v === true ? [input, []] : [[], input];
    }
    case 'n8n-nodes-base.wait': {
      const s = evalExpr(p.amount, ctx);
      await new Promise((r) => setTimeout(r, s * 1000));
      return [input];
    }
    default: throw new Error('unsupported node ' + node.type);
  }
}

async function execute(body) {
  const outputs = { 'Event in': [{ body }] };
  const queue = [['Settings', [{ body }]]];
  while (queue.length) {
    const [name, input] = queue.shift();
    if (!input.length) continue;
    const node = byName[name];
    const outs = await runNode(node, input, outputs);
    outputs[name] = outs[0].length ? outs[0] : outs[1] || [];
    const conns = (wf.connections[name] || { main: [] }).main;
    conns.forEach((targets, i) => targets.forEach((t) => queue.push([t.node, outs[i] || []])));
  }
}

http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    res.end('{"message":"Workflow was started"}');
    execute(JSON.parse(data)).catch((e) => console.error('RUN FAILED', e.message));
  });
}).listen(3200, () => console.log('harness on 3200'));
