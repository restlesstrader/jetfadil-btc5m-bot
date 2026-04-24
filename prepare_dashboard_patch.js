#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'jetfadil_style_btc5m_paper_v1.js';
const inputPath = path.resolve(process.cwd(), inputFile);

if (!fs.existsSync(inputPath)) {
  console.error('ERROR: Bot file not found:', inputFile);
  process.exit(1);
}

let src = fs.readFileSync(inputPath, 'utf8');

if (!src.includes("const express = require('express');") && !src.includes('const express = require("express");')) {
  src = src.replace(
    "const WebSocket = require('ws');",
    "const WebSocket = require('ws');\nconst express = require('express');"
  );
}

const dashboardCode = String.raw`

function startDashboard() {
  const app = express();

  app.get('/api/status', (req, res) => {
    try {
      const timer = slugTimerInfo();
      const upPx = currentMid('up');
      const downPx = currentMid('down');
      const openLots = currentOpenLotsForSlug(state.slug);

      res.json({
        updated: nowIso(),
        slug: state.slug,
        label: state.marketLabel,
        elapsed: timer ? fmtMmSs(timer.elapsedSec) : '-',
        rolloverIn: timer ? fmtMmSs(timer.remainingSec) : '-',
        upPrice: Number.isFinite(upPx) ? upPx : null,
        downPrice: Number.isFinite(downPx) ? downPx : null,
        leader: state.strategy.leader,
        laggard: state.strategy.laggard,
        score: state.strategy.score,
        status: state.strategy.status,
        reason: state.strategy.reason,
        lastAction: state.strategy.lastAction,
        bankrollStart: state.paper.bankrollStart,
        availableCash: state.paper.availableCash,
        lockedCapital: state.paper.lockedCapital,
        realizedPnl: state.paper.realizedPnl,
        totalBuys: state.paper.totalBuys,
        settled: state.paper.totalSettled,
        wins: state.paper.wins,
        losses: state.paper.losses,
        openLots,
        recentActions: state.recentActions.slice(-20).reverse()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(String.raw\`
<!DOCTYPE html>
<html>
<head>
  <title>JetFadil Bot Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: Arial, sans-serif; background:#0b0f19; color:#e5e7eb; padding:20px; }
    h1 { color:#38bdf8; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .card { background:#111827; padding:16px; border-radius:12px; border:1px solid #1f2937; margin-bottom:12px; }
    .big { font-size:26px; font-weight:bold; }
    .green { color:#22c55e; }
    .red { color:#ef4444; }
    .yellow { color:#facc15; }
    .muted { color:#9ca3af; }
    table { width:100%; border-collapse:collapse; margin-top:10px; font-size:14px; }
    td, th { padding:8px; border-bottom:1px solid #1f2937; text-align:left; }
  </style>
</head>
<body>
  <h1>JetFadil BTC 5m Bot Dashboard</h1>
  <div class="muted" id="updated">Loading...</div>

  <div class="grid">
    <div class="card"><div>Status</div><div class="big" id="status">-</div></div>
    <div class="card"><div>Realized P&L</div><div class="big" id="pnl">-</div></div>
    <div class="card"><div>Available Cash</div><div class="big yellow" id="cash">-</div></div>
    <div class="card"><div>Locked Capital</div><div class="big yellow" id="locked">-</div></div>
    <div class="card"><div>UP Price</div><div class="big green" id="up">-</div></div>
    <div class="card"><div>DOWN Price</div><div class="big red" id="down">-</div></div>
    <div class="card"><div>Slug Timer</div><div class="big" id="timer">-</div></div>
    <div class="card"><div>Score</div><div class="big" id="score">-</div></div>
  </div>

  <div class="card">
    <h2>Strategy</h2>
    <p><b>Slug:</b> <span id="slug">-</span></p>
    <p><b>Reason:</b> <span id="reason">-</span></p>
    <p><b>Last Action:</b> <span id="lastAction">-</span></p>
    <p><b>Trades:</b> <span id="trades">-</span></p>
  </div>

  <div class="card">
    <h2>Open Lots</h2>
    <table>
      <thead><tr><th>Side</th><th>Qty</th><th>Entry</th><th>USD</th><th>Source</th></tr></thead>
      <tbody id="lots"></tbody>
    </table>
  </div>

<script>
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();

    document.getElementById('updated').innerText = 'Updated: ' + d.updated;
    document.getElementById('status').innerText = d.status || '-';

    const pnl = Number(d.realizedPnl || 0);
    const pnlEl = document.getElementById('pnl');
    pnlEl.innerText = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    pnlEl.className = 'big ' + (pnl >= 0 ? 'green' : 'red');

    document.getElementById('cash').innerText = '$' + Number(d.availableCash || 0).toFixed(2);
    document.getElementById('locked').innerText = '$' + Number(d.lockedCapital || 0).toFixed(2);
    document.getElementById('up').innerText = d.upPrice ? Math.round(d.upPrice * 100) + 'c' : '-';
    document.getElementById('down').innerText = d.downPrice ? Math.round(d.downPrice * 100) + 'c' : '-';
    document.getElementById('timer').innerText = d.elapsed + ' / ' + d.rolloverIn;
    document.getElementById('score').innerText = d.score;
    document.getElementById('slug').innerText = d.slug || '-';
    document.getElementById('reason').innerText = d.reason || '-';
    document.getElementById('lastAction').innerText = d.lastAction || '-';
    document.getElementById('trades').innerText = 'Buys: ' + d.totalBuys + ' | Settled: ' + d.settled + ' | W: ' + d.wins + ' | L: ' + d.losses;

    const tbody = document.getElementById('lots');
    tbody.innerHTML = '';

    if (!d.openLots || d.openLots.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5">No open lots</td></tr>';
      return;
    }

    for (const lot of d.openLots) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + String(lot.side || '').toUpperCase() + '</td>' +
        '<td>' + lot.qty + '</td>' +
        '<td>' + Math.round(lot.entryPrice * 100) + 'c</td>' +
        '<td>$' + Number(lot.entryUsd).toFixed(2) + '</td>' +
        '<td>' + lot.source + '</td>';
      tbody.appendChild(tr);
    }
  } catch (err) {
    document.getElementById('status').innerText = 'DASHBOARD ERROR';
    document.getElementById('reason').innerText = err.message;
  }
}

loadStatus();
setInterval(loadStatus, 1000);
</script>
</body>
</html>
    \`);
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    logEvent('DASHBOARD_RUNNING | port=' + PORT);
  });
}
`;

if (!src.includes('function startDashboard()')) {
  src = src.replace('async function main() {', dashboardCode + '\nasync function main() {');
}

if (!src.includes('startDashboard();')) {
  src = src.replace('async function main() {', 'async function main() {\n  startDashboard();');
}

const outputPath = path.resolve(process.cwd(), inputFile.replace(/\.js$/i, '_dashboard.js'));
fs.writeFileSync(outputPath, src, 'utf8');
console.log('Dashboard bot created:', path.basename(outputPath));
