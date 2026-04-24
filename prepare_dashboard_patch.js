#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const input = process.argv[2] || 'jetfadil_style_btc5m_paper_v1.js';
const inputPath = path.resolve(process.cwd(), input);

if (!fs.existsSync(inputPath)) {
  console.error(`ERROR: Missing ${input}`);
  console.error('Put your original bot file in this folder with the exact name: jetfadil_style_btc5m_paper_v1.js');
  process.exit(1);
}

let code = fs.readFileSync(inputPath, 'utf8');

if (!code.includes("const express = require('express');") && !code.includes('const express = require("express");')) {
  code = code.replace(
    "const WebSocket = require('ws');",
    "const WebSocket = require('ws');\nconst express = require('express');"
  );
}

const dashboardCode = String.raw`

function startDashboard() {
  const app = express();

  app.get('/api/status', (req, res) => {
    const timer = slugTimerInfo();
    const upPx = currentMid('up');
    const downPx = currentMid('down');
    const openLots = currentOpenLotsForSlug(state.slug);
    const allOpenLots = state.paper.openLots || [];
    const recentClosed = (state.paper.closedLots || []).slice(-60).reverse();

    let unrealizedPnl = 0;
    if (openLots.length && Number.isFinite(upPx) && Number.isFinite(downPx)) {
      const liveWinner = upPx > downPx ? 'up' : 'down';
      for (const lot of openLots) {
        const payout = lot.side === liveWinner ? lot.qty : 0;
        unrealizedPnl += payout - lot.entryUsd;
      }
    }

    res.json({
      updated: nowIso(),
      slug: state.slug,
      question: state.question,
      label: state.marketLabel,
      elapsedSec: timer ? timer.elapsedSec : null,
      remainingSec: timer ? timer.remainingSec : null,
      elapsed: timer ? fmtMmSs(timer.elapsedSec) : '-',
      rolloverIn: timer ? fmtMmSs(timer.remainingSec) : '-',
      upPrice: Number.isFinite(upPx) ? upPx : null,
      downPrice: Number.isFinite(downPx) ? downPx : null,
      leader: state.strategy.leader,
      laggard: state.strategy.laggard,
      leaderPrice: state.strategy.leaderPrice,
      laggardPrice: state.strategy.laggardPrice,
      score: state.strategy.score,
      components: state.strategy.components,
      status: state.strategy.status,
      reason: state.strategy.reason,
      lastAction: state.strategy.lastAction,
      bankrollStart: state.paper.bankrollStart,
      availableCash: state.paper.availableCash,
      lockedCapital: state.paper.lockedCapital,
      claimableCash: state.paper.claimableCash,
      realizedPnl: state.paper.realizedPnl,
      unrealizedPnl,
      totalEquity: state.paper.availableCash + state.paper.lockedCapital + state.paper.claimableCash + state.paper.realizedPnl,
      totalBuys: state.paper.totalBuys,
      settled: state.paper.totalSettled,
      wins: state.paper.wins,
      losses: state.paper.losses,
      winrate: state.paper.totalSettled ? (state.paper.wins / state.paper.totalSettled) * 100 : 0,
      openLots,
      allOpenLots,
      recentClosed,
      recentActions: state.recentActions.slice(-40).reverse(),
      logs: state.logLines.slice(-18).reverse()
    });
  });

  app.get('/', (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>JetFadil BTC 5m Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root { --bg:#070b13; --card:#111827; --card2:#0f172a; --line:#253044; --text:#e5e7eb; --muted:#9ca3af; --green:#22c55e; --red:#ef4444; --yellow:#facc15; --blue:#38bdf8; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial, Helvetica, sans-serif; background:linear-gradient(180deg,#020617,#0f172a); color:var(--text); padding:16px; }
    .wrap { max-width:1200px; margin:0 auto; }
    h1 { margin:0; font-size:24px; color:var(--blue); }
    h2 { margin:0 0 12px; font-size:18px; }
    .top { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:14px; }
    .pill { display:inline-block; padding:6px 10px; border-radius:999px; background:#0b1220; border:1px solid var(--line); color:var(--muted); font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }
    .card { background:rgba(17,24,39,.92); border:1px solid var(--line); border-radius:16px; padding:14px; box-shadow:0 12px 32px rgba(0,0,0,.25); }
    .label { color:var(--muted); font-size:12px; margin-bottom:6px; }
    .big { font-size:26px; font-weight:800; letter-spacing:-.5px; }
    .green { color:var(--green); } .red { color:var(--red); } .yellow { color:var(--yellow); } .blue { color:var(--blue); }
    .section { margin-top:12px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { padding:9px 8px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
    th { color:var(--muted); font-weight:600; }
    .scroll { overflow:auto; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:12px; color:#cbd5e1; }
    .reason { line-height:1.4; color:#cbd5e1; }
    canvas { max-height:280px; }
    @media (max-width:700px) { .top { flex-direction:column; } .big{font-size:22px;} body{padding:10px;} }
  </style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>JetFadil BTC 5m Bot Dashboard</h1>
      <div class="pill" id="updated">Loading...</div>
    </div>
    <div class="pill" id="slug">slug: -</div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Status</div><div class="big blue" id="status">-</div></div>
    <div class="card"><div class="label">Realized P&L</div><div class="big" id="pnl">-</div></div>
    <div class="card"><div class="label">Unrealized P&L</div><div class="big" id="upnl">-</div></div>
    <div class="card"><div class="label">Available Cash</div><div class="big yellow" id="cash">-</div></div>
    <div class="card"><div class="label">Locked Capital</div><div class="big yellow" id="locked">-</div></div>
    <div class="card"><div class="label">UP Price</div><div class="big green" id="up">-</div></div>
    <div class="card"><div class="label">DOWN Price</div><div class="big red" id="down">-</div></div>
    <div class="card"><div class="label">Timer</div><div class="big" id="timer">-</div></div>
    <div class="card"><div class="label">Score</div><div class="big blue" id="score">-</div></div>
    <div class="card"><div class="label">Winrate</div><div class="big" id="winrate">-</div></div>
  </div>

  <div class="grid section">
    <div class="card" style="grid-column:span 2; min-width:300px;">
      <h2>P&L Chart</h2>
      <canvas id="pnlChart"></canvas>
    </div>
    <div class="card">
      <h2>Strategy</h2>
      <p class="reason"><b>Reason:</b> <span id="reason">-</span></p>
      <p class="reason"><b>Last Action:</b> <span id="lastAction">-</span></p>
      <p class="reason"><b>Trades:</b> <span id="trades">-</span></p>
    </div>
  </div>

  <div class="card section">
    <h2>Open Lots</h2>
    <div class="scroll"><table><thead><tr><th>Side</th><th>Qty</th><th>Entry</th><th>USD</th><th>Source</th><th>Opened</th></tr></thead><tbody id="lots"></tbody></table></div>
  </div>

  <div class="card section">
    <h2>Recent Actions</h2>
    <div class="scroll"><table><thead><tr><th>Kind</th><th>Side</th><th>Price</th><th>Qty</th><th>USD</th><th>Source</th><th>Reason</th></tr></thead><tbody id="actions"></tbody></table></div>
  </div>

  <div class="card section">
    <h2>Recent Logs</h2>
    <div class="mono" id="logs">-</div>
  </div>
</div>

<script>
const fmtUsd = (n) => '$' + Number(n || 0).toFixed(2);
const fmtSigned = (n) => (Number(n || 0) >= 0 ? '+$' : '-$') + Math.abs(Number(n || 0)).toFixed(2);
const fmtPrice = (n) => Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) + 'c' : '-';
const clsPnl = (el, n) => { el.className = 'big ' + (Number(n || 0) >= 0 ? 'green' : 'red'); };
const pnlPoints = [];
let chart;

function ensureChart() {
  if (chart) return chart;
  const ctx = document.getElementById('pnlChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Realized P&L', data: [], tension: .25 }] },
    options: { responsive:true, animation:false, scales:{ x:{ ticks:{ color:'#9ca3af' }, grid:{ color:'#1f2937' } }, y:{ ticks:{ color:'#9ca3af' }, grid:{ color:'#1f2937' } } }, plugins:{ legend:{ labels:{ color:'#e5e7eb' } } } }
  });
  return chart;
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status', { cache:'no-store' });
    const d = await r.json();

    document.getElementById('updated').innerText = 'Updated: ' + new Date(d.updated).toLocaleTimeString();
    document.getElementById('slug').innerText = 'slug: ' + (d.slug || '-');
    document.getElementById('status').innerText = d.status || '-';

    const pnlEl = document.getElementById('pnl');
    pnlEl.innerText = fmtSigned(d.realizedPnl); clsPnl(pnlEl, d.realizedPnl);
    const upnlEl = document.getElementById('upnl');
    upnlEl.innerText = fmtSigned(d.unrealizedPnl); clsPnl(upnlEl, d.unrealizedPnl);

    document.getElementById('cash').innerText = fmtUsd(d.availableCash);
    document.getElementById('locked').innerText = fmtUsd(d.lockedCapital);
    document.getElementById('up').innerText = fmtPrice(d.upPrice);
    document.getElementById('down').innerText = fmtPrice(d.downPrice);
    document.getElementById('timer').innerText = (d.elapsed || '-') + ' / ' + (d.rolloverIn || '-');
    document.getElementById('score').innerText = d.score ?? '-';
    document.getElementById('winrate').innerText = Number(d.winrate || 0).toFixed(1) + '%';
    document.getElementById('reason').innerText = d.reason || '-';
    document.getElementById('lastAction').innerText = d.lastAction || '-';
    document.getElementById('trades').innerText = 'Buys: ' + d.totalBuys + ' | Settled: ' + d.settled + ' | W: ' + d.wins + ' | L: ' + d.losses;

    const t = new Date().toLocaleTimeString();
    pnlPoints.push({ t, y: Number(d.realizedPnl || 0) });
    while (pnlPoints.length > 90) pnlPoints.shift();
    const c = ensureChart();
    c.data.labels = pnlPoints.map(x => x.t);
    c.data.datasets[0].data = pnlPoints.map(x => x.y);
    c.update();

    const lots = document.getElementById('lots');
    lots.innerHTML = '';
    if (!d.openLots || d.openLots.length === 0) lots.innerHTML = '<tr><td colspan="6">No open lots</td></tr>';
    else for (const lot of d.openLots) lots.innerHTML += '<tr><td>' + String(lot.side || '').toUpperCase() + '</td><td>' + Number(lot.qty || 0).toFixed(0) + '</td><td>' + fmtPrice(lot.entryPrice) + '</td><td>' + fmtUsd(lot.entryUsd) + '</td><td>' + (lot.source || '-') + '</td><td>' + (lot.minuteInSlugSec != null ? lot.minuteInSlugSec + 's' : '-') + '</td></tr>';

    const actions = document.getElementById('actions');
    actions.innerHTML = '';
    if (!d.recentActions || d.recentActions.length === 0) actions.innerHTML = '<tr><td colspan="7">No recent actions</td></tr>';
    else for (const a of d.recentActions.slice(0, 18)) actions.innerHTML += '<tr><td>' + (a.kind || '-') + '</td><td>' + String(a.side || '').toUpperCase() + '</td><td>' + fmtPrice(a.price) + '</td><td>' + Number(a.qty || 0).toFixed(0) + '</td><td>' + fmtUsd(a.usd) + '</td><td>' + (a.source || '-') + '</td><td>' + (a.reason || '-') + '</td></tr>';

    document.getElementById('logs').innerHTML = (d.logs || []).map(x => String(x).replace(/[<>&]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]))).join('<br>') || '-';
  } catch (e) {
    document.getElementById('status').innerText = 'DASHBOARD ERROR';
    document.getElementById('reason').innerText = e.message;
  }
}

loadStatus();
setInterval(loadStatus, 1000);
</script>
</body>
</html>`);
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    logEvent(`DASHBOARD_RUNNING | port=${PORT}`);
  });
}
`;

if (!code.includes('function startDashboard()')) {
  const marker = 'async function main() {';
  if (!code.includes(marker)) {
    console.error('ERROR: Could not find async function main() in bot file.');
    process.exit(1);
  }
  code = code.replace(marker, dashboardCode + '\n' + marker);
}

if (!code.includes('startDashboard();')) {
  code = code.replace(
    'async function main() {',
    'async function main() {\n  startDashboard();'
  );
}

const outputPath = path.resolve(process.cwd(), 'jetfadil_style_btc5m_paper_v1_dashboard.js');
fs.writeFileSync(outputPath, code, 'utf8');
console.log(`Dashboard bot ready: ${path.basename(outputPath)}`);
