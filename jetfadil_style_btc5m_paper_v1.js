#!/usr/bin/env node
'use strict';

/**
 * JetFadil-Style BTC 5m Strategy Bot v3.1 (PAPER ONLY)
 *
 * Inference-based strategy from the uploaded JetFadil session log:
 * - Uses ~40-contract clips as the base unit
 * - Builds a dynamic bias toward the stronger side
 * - Still buys cheap hedge clips on the weaker side when it gets discounted
 * - Adds in waves instead of one all-in order
 * - Holds to slug settlement in paper mode
 *
 * Runtime data:
 * - gamma-api.polymarket.com/markets for active BTC 5m discovery
 * - gamma-api.polymarket.com/markets/slug/{slug} for metadata / settlement refresh
 * - ws-subscriptions-clob.polymarket.com/ws/market for live market books
 *
 * How to run:
 *   npm install ws
 *   node "Apr-21 JetFadil-Style BTC 5m Strategy Bot v3.1.js"
 *
 * Optional:
 *   node "Apr-21 JetFadil-Style BTC 5m Strategy Bot v3.1.js" --bankroll 1000 --shares 5
 *   node "Apr-21 JetFadil-Style BTC 5m Strategy Bot v3.1.js" --auto-discover true --render-ms 1000
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const GAMMA_MARKET_BY_SLUG = `${GAMMA_API}/markets/slug/`;
const GAMMA_MARKETS = `${GAMMA_API}/markets`;
const WS_MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));

function parseBool(v, fallback) {
  if (v === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

function parseNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const CONFIG = {
  pattern: String(argv.pattern || 'btc-updown-5m-').toLowerCase(),
  autoDiscover: parseBool(argv['auto-discover'], true),
  slug: argv.slug ? String(argv.slug) : null,
  shares: Math.max(1, parseNum(argv.shares, 5)),
  bankroll: Math.max(100, parseNum(argv.bankroll, 1000)),
  renderMs: Math.max(500, parseNum(argv['render-ms'], 1000)),
  tickMs: Math.max(250, parseNum(argv['tick-ms'], 500)),
  marketPollMs: Math.max(1000, parseNum(argv['market-poll-ms'], 1200)),
  resolveGraceSec: Math.max(3, parseNum(argv['resolve-grace-sec'], 10)),
  exportDir: path.resolve(String(argv['export-dir'] || path.join(process.cwd(), 'Apr-21 JetFadil-Style BTC 5m Strategy Bot v3.1'))),
  screen: parseBool(argv.screen, true),

  // Strategy controls
  probeWindowSec: Math.max(10, parseNum(argv['probe-window-sec'], 45)),
  addWindowSec: Math.max(30, parseNum(argv['add-window-sec'], 210)),
  lateWindowSec: Math.max(30, parseNum(argv['late-window-sec'], 210)),
  strongMinPrice: parseNum(argv['strong-min-price'], 0.58),
  strongMaxPrice: parseNum(argv['strong-max-price'], 0.72),
  cheapMaxPrice: parseNum(argv['cheap-max-price'], 0.24),
  cheapMaxPriceLoose: parseNum(argv['cheap-max-price-loose'], 0.28),
  cheapLooseMinEdge: parseNum(argv['cheap-loose-min-edge'], 0.48),
  ultraCheapMaxPrice: parseNum(argv['ultra-cheap-max-price'], 0.12),
  minStrongScore: Math.max(1, parseNum(argv['min-strong-score'], 5)),
  minProbeScore: Math.max(1, parseNum(argv['min-probe-score'], 4)),
  minLateScore: Math.max(1, parseNum(argv['min-late-score'], 6)),
  minAnchorScore: Math.max(1, parseNum(argv['min-anchor-score'], 5)),
  minAnchorEdge: parseNum(argv['min-anchor-edge'], 0.18),
  minAnchorStreakSec: Math.max(1, parseNum(argv['min-anchor-streak-sec'], 14)),
  minFlipScore: Math.max(1, parseNum(argv['min-flip-score'], 6)),
  minFlipEdge: parseNum(argv['min-flip-edge'], 0.22),
  minFlipStreakSec: Math.max(1, parseNum(argv['min-flip-streak-sec'], 18)),
  allowFlip: parseBool(argv['allow-flip'], false),
  maxFlipSec: Math.max(30, parseNum(argv['max-flip-sec'], 150)),
  minGapSecStrong: Math.max(1, parseNum(argv['min-gap-sec-strong'], 22)),
  minGapSecCheap: Math.max(1, parseNum(argv['min-gap-sec-cheap'], 26)),
  minGapSecProbe: Math.max(1, parseNum(argv['min-gap-sec-probe'], 16)),
  minPriceStepStrong: parseNum(argv['min-price-step-strong'], 0.045),
  minPriceStepCheap: parseNum(argv['min-price-step-cheap'], 0.040),
  probeQtyFrac: Math.max(0.1, parseNum(argv['probe-qty-frac'], 1.0)),
  strongQtyFrac: Math.max(0.1, parseNum(argv['strong-qty-frac'], 1.0)),
  cheapQtyFrac: Math.max(0.1, parseNum(argv['cheap-qty-frac'], 0.5)),
  maxOpenLots: Math.max(1, parseNum(argv['max-open-lots'], 6)),
  maxStrongAdds: Math.max(1, parseNum(argv['max-strong-adds'], 2)),
  maxCheapAdds: Math.max(0, parseNum(argv['max-cheap-adds'], 1)),
  maxProbeAdds: Math.max(0, parseNum(argv['max-probe-adds'], 2)),
  historyMax: Math.max(20, parseNum(argv['history-max'], 180)),
};

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

const BOT_DATE_PREFIX = 'Apr-21';
const BOT_STAMP = '[Date created Apr/21/2026 12:05am]';
const BOT_TITLE = `JetFadil-Style BTC 5m Strategy Bot v3.1 ${BOT_STAMP} (local time)`;

const state = {
  slug: null,
  question: '',
  marketLabel: '',
  endDate: '',
  marketId: null,
  upToken: null,
  downToken: null,
  upBook: { bids: [], asks: [] },
  downBook: { bids: [], asks: [] },
  upMidHistory: [],
  downMidHistory: [],
  upTradeHistory: [],
  downTradeHistory: [],
  ws: null,
  sessionStartedAtSec: nowSec(),
  lastRender: 0,
  logLines: [],
  recentActions: [],
  paths: {},
  strategy: {
    status: 'WAITING',
    reason: 'Waiting for market',
    leader: null,
    laggard: null,
    leaderPrice: null,
    laggardPrice: null,
    score: 0,
    components: {},
    lastAction: 'NONE',
  },
  slugState: {
    strongAddsBySide: { up: 0, down: 0 },
    cheapAddsBySide: { up: 0, down: 0 },
    probeAddsBySide: { up: 0, down: 0 },
    lastEntryAtBySide: { up: 0, down: 0 },
    lastStrongEntryPriceBySide: { up: null, down: null },
    lastCheapEntryPriceBySide: { up: null, down: null },
    anchorSide: null,
    anchorLockedAtSec: 0,
    anchorReason: 'not locked',
    leaderStreakSide: null,
    leaderStreakStartSec: 0,
    leaderStreakSec: 0,
    flipsUsed: 0,
  },
  paper: {
    bankrollStart: CONFIG.bankroll,
    availableCash: CONFIG.bankroll,
    lockedCapital: 0,
    claimableCash: 0,
    realizedPnl: 0,
    openLots: [],
    closedLots: [],
    slugHistory: [],
    totalBuys: 0,
    totalSettled: 0,
    wins: 0,
    losses: 0,
  },
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function initPaths() {
  ensureDir(CONFIG.exportDir);
  ensureDir(path.join(CONFIG.exportDir, 'slug_logs'));
  state.paths.sessionLog = path.join(CONFIG.exportDir, `${BOT_DATE_PREFIX} JetFadil-Style BTC 5m Strategy Bot v3.1 session_log.txt`);
  state.paths.statusFile = path.join(CONFIG.exportDir, `${BOT_DATE_PREFIX} JetFadil-Style BTC 5m Strategy Bot v3.1 status.txt`);
  state.paths.summaryFile = path.join(CONFIG.exportDir, `${BOT_DATE_PREFIX} JetFadil-Style BTC 5m Strategy Bot v3.1 summary.txt`);
  state.paths.stateFile = path.join(CONFIG.exportDir, `${BOT_DATE_PREFIX} JetFadil-Style BTC 5m Strategy Bot v3.1 state.json`);
  state.paths.lockFile = path.join(CONFIG.exportDir, '.bot_instance.lock');
}

initPaths();

function acquireInstanceLock() {
  try {
    fs.writeFileSync(state.paths.lockFile, String(process.pid), { flag: 'wx' });
  } catch (err) {
    console.error(`Another instance appears to be running for this export dir: ${CONFIG.exportDir}`);
    console.error('Use a different --export-dir or close the other bot first.');
    process.exit(1);
  }
}

function releaseInstanceLock() {
  try { if (state.paths.lockFile) fs.unlinkSync(state.paths.lockFile); } catch {}
}

function saveCheckpoint() {
  const snapshot = {
    savedAtIso: nowIso(),
    savedAtSec: nowSec(),
    sessionStartedAtSec: state.sessionStartedAtSec,
    slug: state.slug,
    question: state.question,
    marketLabel: state.marketLabel,
    endDate: state.endDate,
    marketId: state.marketId,
    upToken: state.upToken,
    downToken: state.downToken,
    strategy: state.strategy,
    slugState: state.slugState,
    paper: state.paper,
    recentActions: state.recentActions,
    logLines: state.logLines,
  };
  const tmp = `${state.paths.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tmp, state.paths.stateFile);
}

function loadCheckpoint() {
  try {
    if (!state.paths.stateFile || !fs.existsSync(state.paths.stateFile)) return false;
    const raw = fs.readFileSync(state.paths.stateFile, 'utf8');
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return false;
    state.sessionStartedAtSec = Number(saved.sessionStartedAtSec || nowSec());
    state.slug = saved.slug || null;
    state.question = saved.question || '';
    state.marketLabel = saved.marketLabel || '';
    state.endDate = saved.endDate || '';
    state.marketId = saved.marketId || null;
    state.upToken = saved.upToken || null;
    state.downToken = saved.downToken || null;
    state.strategy = saved.strategy && typeof saved.strategy === 'object' ? saved.strategy : state.strategy;
    state.slugState = saved.slugState && typeof saved.slugState === 'object' ? saved.slugState : state.slugState;
    state.paper = saved.paper && typeof saved.paper === 'object' ? saved.paper : state.paper;
    state.recentActions = Array.isArray(saved.recentActions) ? saved.recentActions : [];
    state.logLines = Array.isArray(saved.logLines) ? saved.logLines.slice(-10) : [];
    addScreenLog(`session restored from ${saved.savedAtIso || 'checkpoint'}`);
    return true;
  } catch (err) {
    console.error(`Failed to load saved session: ${err.message}`);
    return false;
  }
}

function sessionElapsedSec() {
  return Math.max(0, nowSec() - Number(state.sessionStartedAtSec || nowSec()));
}

function colorBlue(text) {
  return `${ANSI.blue}${text}${ANSI.reset}`;
}

function colorYellow(text) {
  return `${ANSI.yellow}${text}${ANSI.reset}`;
}

function colorRealized(v) {
  const n = Number(v || 0);
  const raw = `realized=${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
  if (n > 0) return `${ANSI.green}${raw}${ANSI.reset}`;
  if (n < 0) return `${ANSI.red}${raw}${ANSI.reset}`;
  return raw;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function compactLogMessage(msg) {
  return String(msg || '')
    .replace(/\s*\|\s*label=[^|]+/g, '')
    .replace(/\s*\|\s*reason=[^|]+/g, '')
    .replace(/\s*\|\s*t_in_slug=[^|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowIso() { return new Date().toISOString(); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function round2(v) { return Number(v || 0).toFixed(2); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pushLimited(arr, item, maxLen) { arr.push(item); while (arr.length > maxLen) arr.shift(); }
function bestBid(book) { return book.bids.length ? book.bids[0] : null; }
function bestAsk(book) { return book.asks.length ? book.asks[0] : null; }
function fmtUsd(v) { return Number.isFinite(v) ? `$${Number(v).toFixed(2)}` : '-'; }
function fmtPrice(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}c` : '-'; }
function fmtMmSs(sec) { if (!Number.isFinite(sec)) return '-'; const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function shortHash(hash) { const x = String(hash || ''); return x.length <= 14 ? (x || '-') : `${x.slice(0, 8)}...${x.slice(-6)}`; }

function colorSide(side, text) {
  const t = text || String(side || '').toUpperCase();
  const s = String(side || '').toLowerCase();
  if (s === 'up') return `${ANSI.green}${t}${ANSI.reset}`;
  if (s === 'down') return `${ANSI.red}${t}${ANSI.reset}`;
  return t;
}

function colorPnl(v, text) {
  const n = Number(v || 0);
  const base = text || `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
  if (n > 0) return `${ANSI.green}${base}${ANSI.reset}`;
  if (n < 0) return `${ANSI.red}${base}${ANSI.reset}`;
  return base;
}

function addScreenLog(msg) {
  pushLimited(state.logLines, `[${new Date().toLocaleTimeString()}] ${compactLogMessage(msg)}`, 8);
}

function appendFileLine(filePath, line) {
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

function slugFileBase(slug) {
  return String(slug || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function slugLogPath(slug) {
  return path.join(CONFIG.exportDir, 'slug_logs', `${slugFileBase(slug)}.txt`);
}

function writeStructuredLog(line, slug = null) {
  appendFileLine(state.paths.sessionLog, line);
  if (slug) appendFileLine(slugLogPath(slug), line);
}

function logEvent(message, slug = null) {
  const line = `${nowIso()} | ${message}`;
  writeStructuredLog(line, slug);
  addScreenLog(message);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} ${text}`.trim());
  }
  return res.json();
}

function tryParseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function normalizeOutcome(value) {
  const x = String(value || '').trim().toLowerCase();
  if (!x) return null;
  if (x === 'up' || x === 'yes') return 'up';
  if (x === 'down' || x === 'no') return 'down';
  if (/\bup\b/.test(x)) return 'up';
  if (/\bdown\b/.test(x)) return 'down';
  return null;
}

function marketMatchesPattern(m) {
  const slug = String(m.slug || '').toLowerCase();
  const q = `${String(m.question || '').toLowerCase()} ${String(m.title || '').toLowerCase()} ${String(m.eventSlug || m.event_slug || '').toLowerCase()}`;
  const strictSlug = slug.startsWith(CONFIG.pattern);
  const explicitText = /bitcoin up or down/.test(q) && /(?:\b5m\b|\b5 minutes\b)/.test(q) && !/(?:\b15m\b|\b15 minutes\b|\b30m\b|\b30 minutes\b|\b1h\b|\b1 hour\b)/.test(q);
  return strictSlug || explicitText;
}

function slugStartSec(slug) {
  const m = String(slug || '').match(/btc-updown-5m-(\d{10})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function elapsedInSlugSec(slug, unixSec) {
  const start = slugStartSec(slug);
  if (!Number.isFinite(start) || !Number.isFinite(unixSec)) return null;
  return Math.max(0, Math.floor(unixSec - start));
}

function chartMarketLabel(slug, endDate) {
  const startSec = slugStartSec(slug);
  if (Number.isFinite(startSec)) {
    const start = new Date(startSec * 1000);
    const end = new Date((startSec + 5 * 60) * 1000);
    const date = start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/AM/g, 'am').replace(/PM/g, 'pm');
    const e = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/AM/g, 'am').replace(/PM/g, 'pm');
    return `${date}, ${s}-${e}`;
  }
  if (endDate) {
    const endMs = new Date(endDate).getTime();
    if (Number.isFinite(endMs)) {
      const start = new Date(endMs - 5 * 60 * 1000);
      const end = new Date(endMs);
      const date = start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
      const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/AM/g, 'am').replace(/PM/g, 'pm');
      const e = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/AM/g, 'am').replace(/PM/g, 'pm');
      return `${date}, ${s}-${e}`;
    }
  }
  return slug || '-';
}

function displaySlugLabel(slug, label) {
  const nice = label || chartMarketLabel(slug, '');
  return `${slug || '-'} - ${nice}`;
}

async function fetchMarketBySlug(slug) {
  const data = await fetchJson(GAMMA_MARKET_BY_SLUG + encodeURIComponent(slug));
  return Array.isArray(data) ? data[0] : data;
}

async function discoverCurrentMarket() {
  const now = Date.now();
  const windowStartIso = new Date(now - 90_000).toISOString();
  const windowEndIso = new Date(now + 20 * 60_000).toISOString();
  const pages = [0, 200, 400];
  let all = [];

  for (const offset of pages) {
    const params = new URLSearchParams({
      closed: 'false',
      limit: '200',
      offset: String(offset),
      order: 'endDate',
      ascending: 'true',
      end_date_min: windowStartIso,
      end_date_max: windowEndIso,
    });
    const markets = await fetchJson(`${GAMMA_MARKETS}?${params.toString()}`);
    if (!Array.isArray(markets)) throw new Error('Expected array from markets listing');
    all = all.concat(markets);
    if (markets.length < 200) break;
  }

  const seen = new Set();
  const unique = all.filter((m) => {
    const slug = String(m.slug || '');
    if (!slug || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });

  const candidates = unique
    .filter((m) => {
      const endMs = new Date(m.endDate || m.end_date || 0).getTime();
      return Number.isFinite(endMs) && endMs >= (now - 15_000) && marketMatchesPattern(m);
    })
    .sort((a, b) => new Date(a.endDate || a.end_date || 0).getTime() - new Date(b.endDate || b.end_date || 0).getTime());

  if (candidates.length) return candidates[0];
  return null;
}

function extractTokenIds(market) {
  if (market.clob_token_up && market.clob_token_down) {
    return [String(market.clob_token_up), String(market.clob_token_down)];
  }

  const clobIds = tryParseArray(market.clobTokenIds) || tryParseArray(market.clob_token_ids);
  if (clobIds && clobIds.length >= 2) return [String(clobIds[0]), String(clobIds[1])];

  const candidates = [
    tryParseArray(market.tokens),
    tryParseArray(market.outcomes),
    Array.isArray(market.tokenData) ? market.tokenData : null,
    Array.isArray(market.outcomeData) ? market.outcomeData : null,
  ].filter(Boolean);

  for (const list of candidates) {
    const ids = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const tokenId = item.clobTokenId || item.clob_token_id || item.tokenId || item.token_id || item.id;
      if (tokenId) ids.push(String(tokenId));
    }
    if (ids.length >= 2) return [ids[0], ids[1]];
  }

  throw new Error('Could not extract Up/Down token IDs');
}

function sortBook(book) {
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
}

function currentMid(side) {
  const book = side === 'up' ? state.upBook : state.downBook;
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid && ask) return (bid.price + ask.price) / 2;
  if (ask) return ask.price;
  if (bid) return bid.price;
  return null;
}

function recordMidHistory() {
  const ts = nowSec();
  const up = currentMid('up');
  const down = currentMid('down');
  if (Number.isFinite(up)) pushLimited(state.upMidHistory, { ts, value: up }, CONFIG.historyMax);
  if (Number.isFinite(down)) pushLimited(state.downMidHistory, { ts, value: down }, CONFIG.historyMax);
}

function midHistoryFor(side) {
  return side === 'up' ? state.upMidHistory : state.downMidHistory;
}

function valueNSecondsAgo(side, secondsAgo) {
  const hist = midHistoryFor(side);
  if (!hist.length) return null;
  const targetTs = nowSec() - secondsAgo;
  let chosen = hist[0].value;
  for (const point of hist) {
    if (point.ts <= targetTs) chosen = point.value;
    else break;
  }
  return Number.isFinite(chosen) ? chosen : null;
}

function resetSlugState() {
  state.upBook = { bids: [], asks: [] };
  state.downBook = { bids: [], asks: [] };
  state.upMidHistory = [];
  state.downMidHistory = [];
  state.upTradeHistory = [];
  state.downTradeHistory = [];
  state.slugState = {
    strongAddsBySide: { up: 0, down: 0 },
    cheapAddsBySide: { up: 0, down: 0 },
    probeAddsBySide: { up: 0, down: 0 },
    lastEntryAtBySide: { up: 0, down: 0 },
    lastStrongEntryPriceBySide: { up: null, down: null },
    lastCheapEntryPriceBySide: { up: null, down: null },
    anchorSide: null,
    anchorLockedAtSec: 0,
    anchorReason: 'not locked',
    leaderStreakSide: null,
    leaderStreakStartSec: 0,
    leaderStreakSec: 0,
    flipsUsed: 0,
  };
  state.strategy = {
    status: 'NEW MARKET',
    reason: 'State reset for new slug',
    leader: null,
    laggard: null,
    leaderPrice: null,
    laggardPrice: null,
    anchorSide: null,
    anchorStreakSec: 0,
    score: 0,
    components: {},
    lastAction: 'STATE RESET',
  };
}

function extractWinnerFromMarketObj(market) {
  if (!market || typeof market !== 'object') return null;
  const direct = [market.resolvedOutcome, market.winner, market.result, market.resolution, market.finalOutcome, market.winningOutcome];
  for (const x of direct) {
    const side = normalizeOutcome(x);
    if (side) return side;
  }

  const outcomePrices = tryParseArray(market.outcomePrices) || tryParseArray(market.outcome_prices);
  if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
    const a = Number(outcomePrices[0]);
    const b = Number(outcomePrices[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 0.20) {
      return a > b ? 'up' : 'down';
    }
  }

  const tokenLists = [
    Array.isArray(market.tokens) ? market.tokens : null,
    Array.isArray(market.outcomes) ? market.outcomes : null,
    Array.isArray(market.tokenData) ? market.tokenData : null,
    Array.isArray(market.outcomeData) ? market.outcomeData : null,
  ].filter(Boolean);

  for (const list of tokenLists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (item.winner === true || item.resolved === true || item.isWinner === true) {
        const side = normalizeOutcome(item.outcome || item.name || item.label || item.title);
        if (side) return side;
      }
    }
  }
  return null;
}

function slugTimerInfo() {
  if (!state.endDate) return null;
  const endSec = Math.floor(new Date(state.endDate).getTime() / 1000);
  if (!Number.isFinite(endSec)) return null;
  const elapsed = elapsedInSlugSec(state.slug, nowSec());
  return {
    elapsedSec: elapsed,
    remainingSec: Math.max(0, endSec - nowSec()),
    endSec,
  };
}

function currentOpenLotsForSlug(slug) {
  return state.paper.openLots
    .filter((x) => x.slug === slug)
    .slice()
    .sort((a, b) => a.openedAtSec - b.openedAtSec || String(a.id).localeCompare(String(b.id)));
}

function totalsBySide(lots) {
  const base = { up: { qty: 0, usd: 0 }, down: { qty: 0, usd: 0 } };
  for (const lot of lots || []) {
    const side = String(lot.side || '').toLowerCase();
    if (!base[side]) continue;
    base[side].qty += Number(lot.qty || 0);
    base[side].usd += Number(lot.entryUsd || 0);
  }
  return base;
}

function formatSideTotalsLine(lots, useColor = false) {
  const totals = totalsBySide(lots);
  const upLabel = useColor ? colorSide('up', 'UP'.padEnd(4)) : 'UP'.padEnd(4);
  const downLabel = useColor ? colorSide('down', 'DOWN'.padEnd(4)) : 'DOWN'.padEnd(4);
  return `${upLabel} total ${totals.up.qty.toFixed(4)} sh | usd ${fmtUsd(totals.up.usd)}   ${downLabel} total ${totals.down.qty.toFixed(4)} sh | usd ${fmtUsd(totals.down.usd)}`;
}

function pushRecentAction(action) {
  pushLimited(state.recentActions, action, 30);
}

function createActionSummary(kind, side, price, qty, usd, source, reason) {
  return {
    ts: nowSec(),
    kind,
    side,
    price,
    qty,
    usd,
    source,
    slug: state.slug,
    label: state.marketLabel,
    reason,
    elapsed: elapsedInSlugSec(state.slug, nowSec()),
  };
}

function canAfford(usd) {
  return state.paper.availableCash + 1e-9 >= usd;
}

function totalOpenLots() {
  return state.paper.openLots.length;
}

function qtyForSource(source) {
  const frac = source === 'cheap-hedge'
    ? CONFIG.cheapQtyFrac
    : source === 'probe'
      ? CONFIG.probeQtyFrac
      : CONFIG.strongQtyFrac;
  return Math.max(1, Math.round(CONFIG.shares * frac * 10000) / 10000);
}

function openPaperLot(side, price, source, reason, qtyOverride = null) {
  const qty = Number.isFinite(qtyOverride) ? qtyOverride : qtyForSource(source);
  const usd = qty * price;
  if (!Number.isFinite(price) || !(price >= 0)) return false;
  if (totalOpenLots() >= CONFIG.maxOpenLots) {
    state.strategy.lastAction = `BLOCK max open lots (${CONFIG.maxOpenLots})`;
    return false;
  }
  if (!canAfford(usd)) {
    state.strategy.lastAction = `BLOCK insufficient cash for ${fmtUsd(usd)}`;
    return false;
  }

  const openedAtSec = nowSec();
  const lot = {
    id: `${state.slug}|${side}|${openedAtSec}|${Math.random().toString(36).slice(2, 6)}`,
    slug: state.slug,
    label: state.marketLabel,
    side,
    qty,
    entryPrice: price,
    entryUsd: usd,
    openedAtSec,
    source,
    reason,
    minuteInSlugSec: elapsedInSlugSec(state.slug, openedAtSec),
  };

  state.paper.openLots.push(lot);
  state.paper.availableCash -= usd;
  state.paper.lockedCapital += usd;
  state.paper.totalBuys += 1;
  state.slugState.lastEntryAtBySide[side] = openedAtSec;

  if (source === 'probe') state.slugState.probeAddsBySide[side] += 1;
  else if (source === 'cheap-hedge') {
    state.slugState.cheapAddsBySide[side] += 1;
    state.slugState.lastCheapEntryPriceBySide[side] = price;
  } else {
    state.slugState.strongAddsBySide[side] += 1;
    state.slugState.lastStrongEntryPriceBySide[side] = price;
  }

  const msg = [
    'STRAT_BUY',
    `slug=${state.slug}`,
    `label=${state.marketLabel}`,
    `side=${side.toUpperCase()}`,
    `px=${price.toFixed(4)}`,
    `shares=${qty.toFixed(4)}`,
    `usd=${usd.toFixed(2)}`,
    `t_in_slug=${fmtMmSs(lot.minuteInSlugSec)}`,
    `source=${source}`,
    `reason=${reason}`,
  ].join(' | ');
  logEvent(msg, state.slug);
  pushRecentAction(createActionSummary('BUY', side, price, qty, usd, source, reason));
  state.strategy.lastAction = `${source.toUpperCase()} ${side.toUpperCase()} @ ${fmtPrice(price)}`;
  return true;
}

function midDiffScore(leaderPrice, laggardPrice, leader20, leader45, laggard20) {
  const edge = leaderPrice - laggardPrice;
  const leaderM20 = Number.isFinite(leader20) ? (leaderPrice - leader20) : 0;
  const leaderM45 = Number.isFinite(leader45) ? (leaderPrice - leader45) : 0;
  const laggardM20 = Number.isFinite(laggard20) ? (laggardPrice - laggard20) : 0;

  let score = 0;
  if (leaderPrice >= 0.52) score += 1;
  if (leaderPrice >= 0.60) score += 1;
  if (leaderPrice >= 0.72) score += 1;
  if (edge >= 0.08) score += 1;
  if (edge >= 0.16) score += 1;
  if (leaderM20 >= 0.03) score += 1;
  if (leaderM45 >= 0.06) score += 1;
  if (laggardPrice <= 0.35) score += 1;
  if (laggardM20 <= -0.03) score += 1;

  return {
    score,
    edge,
    leaderM20,
    leaderM45,
    laggardM20,
  };
}

function evaluateStrategyState() {
  const up = currentMid('up');
  const down = currentMid('down');
  const timer = slugTimerInfo();
  if (!Number.isFinite(up) || !Number.isFinite(down) || !timer) {
    state.strategy.status = 'WAITING';
    state.strategy.reason = 'Waiting for live prices';
    state.strategy.leader = null;
    state.strategy.laggard = null;
    state.strategy.score = 0;
    return null;
  }

  const leader = up >= down ? 'up' : 'down';
  const laggard = leader === 'up' ? 'down' : 'up';
  const leaderPrice = leader === 'up' ? up : down;
  const laggardPrice = laggard === 'up' ? up : down;
  const leader20 = valueNSecondsAgo(leader, 20);
  const leader45 = valueNSecondsAgo(leader, 45);
  const laggard20 = valueNSecondsAgo(laggard, 20);
  const parts = midDiffScore(leaderPrice, laggardPrice, leader20, leader45, laggard20);

  const leaderStreakSec = maybeUpdateAnchor({ up, down, timer, leader, laggard, leaderPrice, laggardPrice, parts });
  const anchorSide = state.slugState.anchorSide;

  state.strategy.leader = leader;
  state.strategy.laggard = laggard;
  state.strategy.leaderPrice = leaderPrice;
  state.strategy.laggardPrice = laggardPrice;
  state.strategy.anchorSide = anchorSide;
  state.strategy.anchorStreakSec = leaderStreakSec;
  state.strategy.score = parts.score;
  state.strategy.components = parts;
  return { up, down, timer, leader, laggard, leaderPrice, laggardPrice, parts, leaderStreakSec, anchorSide };
}

function secondsSinceLastEntry(side) {
  const last = Number(state.slugState.lastEntryAtBySide[side] || 0);
  if (!last) return Infinity;
  return nowSec() - last;
}

function updateLeaderTracking(leader) {
  const now = nowSec();
  if (state.slugState.leaderStreakSide !== leader) {
    state.slugState.leaderStreakSide = leader;
    state.slugState.leaderStreakStartSec = now;
  }
  state.slugState.leaderStreakSec = Math.max(0, now - Number(state.slugState.leaderStreakStartSec || now));
  return state.slugState.leaderStreakSec;
}

function maybeUpdateAnchor(evalState) {
  const { timer, leader, leaderPrice, parts } = evalState;
  const streakSec = updateLeaderTracking(leader);
  const edge = Number(parts.edge || 0);

  if (!state.slugState.anchorSide) {
    if (
      timer.elapsedSec <= CONFIG.maxFlipSec
      && parts.score >= CONFIG.minAnchorScore
      && edge >= CONFIG.minAnchorEdge
      && leaderPrice >= CONFIG.strongMinPrice
      && streakSec >= CONFIG.minAnchorStreakSec
    ) {
      state.slugState.anchorSide = leader;
      state.slugState.anchorLockedAtSec = nowSec();
      state.slugState.anchorReason = `anchor ${leader.toUpperCase()} score=${parts.score} edge=${fmtPrice(edge)} streak=${fmtMmSs(streakSec)}`;
      state.strategy.lastAction = `ANCHOR ${leader.toUpperCase()} | score=${parts.score}`;
      pushRecentAction(createActionSummary('ANCHOR', leader, leaderPrice, 0, 0, 'anchor-lock', state.slugState.anchorReason));
      logEvent(`ANCHOR_LOCK | slug=${state.slug} | label=${state.marketLabel} | side=${leader.toUpperCase()} | px=${leaderPrice.toFixed(4)} | score=${parts.score} | edge=${edge.toFixed(4)} | streak=${fmtMmSs(streakSec)}`, state.slug);
    }
    return streakSec;
  }

  if (
    CONFIG.allowFlip
    && leader !== state.slugState.anchorSide
    && state.slugState.flipsUsed < 1
    && timer.elapsedSec <= CONFIG.maxFlipSec
    && parts.score >= CONFIG.minFlipScore
    && edge >= CONFIG.minFlipEdge
    && streakSec >= CONFIG.minFlipStreakSec
    && leaderPrice >= CONFIG.strongMinPrice
  ) {
    const prev = state.slugState.anchorSide;
    state.slugState.anchorSide = leader;
    state.slugState.anchorLockedAtSec = nowSec();
    state.slugState.anchorReason = `flip ${prev.toUpperCase()}->${leader.toUpperCase()} score=${parts.score} edge=${fmtPrice(edge)} streak=${fmtMmSs(streakSec)}`;
    state.slugState.flipsUsed += 1;
    state.strategy.lastAction = `FLIP ${prev.toUpperCase()} -> ${leader.toUpperCase()} | score=${parts.score}`;
    pushRecentAction(createActionSummary('FLIP', leader, leaderPrice, 0, 0, 'anchor-flip', state.slugState.anchorReason));
    logEvent(`ANCHOR_FLIP | slug=${state.slug} | label=${state.marketLabel} | from=${prev.toUpperCase()} | to=${leader.toUpperCase()} | px=${leaderPrice.toFixed(4)} | score=${parts.score} | edge=${edge.toFixed(4)} | streak=${fmtMmSs(streakSec)}`, state.slug);
  }

  return streakSec;
}


function shouldProbe(evalState) {
  const { timer, leader, leaderPrice, laggard, laggardPrice, parts, leaderStreakSec } = evalState;
  if (timer.elapsedSec > CONFIG.probeWindowSec) return null;
  if (parts.score < CONFIG.minProbeScore) return null;

  const trendTooHot = leaderPrice >= 0.76 && laggardPrice <= 0.24 && Number(parts.edge || 0) >= 0.52;

  if (
    state.slugState.probeAddsBySide[leader] < 1
    && secondsSinceLastEntry(leader) >= CONFIG.minGapSecProbe
    && leaderStreakSec >= 6
    && leaderPrice >= CONFIG.strongMinPrice
    && leaderPrice <= 0.66
  ) {
    return { side: leader, price: leaderPrice, source: 'probe', qty: qtyForSource('probe'), reason: `early leader probe score=${parts.score}` };
  }

  if (
    !trendTooHot
    && state.slugState.probeAddsBySide[laggard] < 1
    && secondsSinceLastEntry(laggard) >= CONFIG.minGapSecProbe
    && laggardPrice >= 0.26
    && laggardPrice <= 0.42
    && Number(parts.edge || 0) <= 0.34
  ) {
    return { side: laggard, price: laggardPrice, source: 'probe', qty: qtyForSource('probe'), reason: `early counter probe cheap=${fmtPrice(laggardPrice)}` };
  }

  return null;
}


function shouldAddStrong(evalState) {
  const { timer, leader, leaderPrice, laggardPrice, parts, anchorSide, leaderStreakSec } = evalState;
  if (timer.elapsedSec > CONFIG.addWindowSec) return null;
  if (!anchorSide) return null;
  if (leader !== anchorSide) return null;
  if (parts.score < CONFIG.minStrongScore) return null;
  if (Number(parts.edge || 0) < CONFIG.minAnchorEdge) return null;
  if (leaderPrice < CONFIG.strongMinPrice || leaderPrice > CONFIG.strongMaxPrice) return null;
  if (state.slugState.strongAddsBySide[leader] >= CONFIG.maxStrongAdds) return null;
  if (secondsSinceLastEntry(leader) < CONFIG.minGapSecStrong) return null;
  if (leaderStreakSec < 10) return null;

  const lastStrong = state.slugState.lastStrongEntryPriceBySide[leader];
  if (Number.isFinite(lastStrong) && Math.abs(leaderPrice - lastStrong) < CONFIG.minPriceStepStrong) return null;
  if (leaderPrice >= 0.70 && Number(parts.edge || 0) < 0.24) return null;
  if (laggardPrice <= 0.20 && leaderPrice >= 0.80) return null;
  if (timer.elapsedSec >= 165 && leaderPrice >= 0.68) return null;

  return { side: leader, price: leaderPrice, source: 'strong-add', qty: qtyForSource('strong-add'), reason: `anchored bias score=${parts.score} edge=${fmtPrice(parts.edge)} streak=${fmtMmSs(leaderStreakSec)}` };
}


function shouldAddCheapHedge(evalState) {
  const { timer, leaderPrice, laggardPrice, parts, anchorSide } = evalState;
  if (timer.elapsedSec > CONFIG.addWindowSec) return null;
  if (!anchorSide) return null;
  const laggard = anchorSide === 'up' ? 'down' : 'up';
  if (state.slugState.cheapAddsBySide[laggard] >= CONFIG.maxCheapAdds) return null;
  if (secondsSinceLastEntry(laggard) < CONFIG.minGapSecCheap) return null;
  if (parts.score < CONFIG.minStrongScore) return null;

  const edge = Number(parts.edge || 0);
  const extremeTrend = leaderPrice >= 0.78 && laggardPrice <= 0.22 && edge >= 0.56;
  const acceptableCheap = laggardPrice <= CONFIG.cheapMaxPrice || (laggardPrice <= CONFIG.cheapMaxPriceLoose && edge <= 0.42);
  if (!acceptableCheap) return null;
  if (extremeTrend) return null;
  if (laggardPrice < 0.10 && leaderPrice > 0.90) return null;
  if (timer.elapsedSec < 105 && laggardPrice < 0.18) return null;

  const lastCheap = state.slugState.lastCheapEntryPriceBySide[laggard];
  if (Number.isFinite(lastCheap) && Math.abs(laggardPrice - lastCheap) < CONFIG.minPriceStepCheap) return null;

  return { side: laggard, price: laggardPrice, source: 'cheap-hedge', qty: qtyForSource('cheap-hedge'), reason: `cheap laggard=${fmtPrice(laggardPrice)} while leader=${fmtPrice(leaderPrice)}` };
}

function shouldLateConvexity(evalState) {
  return null;
}

function pickAction(evalState) {
  const timer = evalState.timer;
  if (!timer) return null;
  if (timer.elapsedSec > CONFIG.lateWindowSec) return null;

  const candidates = [
    shouldProbe(evalState),
    shouldAddStrong(evalState),
    shouldAddCheapHedge(evalState),
    shouldLateConvexity(evalState),
  ].filter(Boolean);

  if (!candidates.length) return null;

  const priority = { 'probe': 1, 'strong-add': 2, 'cheap-hedge': 3 };
  candidates.sort((a, b) => (priority[a.source] || 99) - (priority[b.source] || 99));
  return candidates[0];
}

function strategyTick() {
  const evalState = evaluateStrategyState();
  if (!evalState) return;

  const { timer, leader, laggard, leaderPrice, laggardPrice, parts } = evalState;
  const openLots = currentOpenLotsForSlug(state.slug);
  const totals = totalsBySide(openLots);

  if (timer.elapsedSec > CONFIG.addWindowSec) {
    state.strategy.status = 'HOLDING';
    state.strategy.reason = `Entry window closed; holding to settlement | score=${parts.score} | anchor=${(state.slugState.anchorSide || '-').toUpperCase()}`;
    return;
  }

  const action = pickAction(evalState);
  if (action) {
    const opened = openPaperLot(action.side, action.price, action.source, action.reason, action.qty);
    if (opened) {
      state.strategy.status = 'TRIGGERED';
      state.strategy.reason = `Opened ${action.side.toUpperCase()} via ${action.source} | score=${parts.score}`;
      return;
    }
  }

  state.strategy.status = 'WATCHING';
  state.strategy.reason = `leader=${leader.toUpperCase()} ${fmtPrice(leaderPrice)} | laggard=${laggard.toUpperCase()} ${fmtPrice(laggardPrice)} | anchor=${(state.slugState.anchorSide || '-').toUpperCase()} | score=${parts.score} | streak=${fmtMmSs(state.slugState.leaderStreakSec)} | strong=${state.slugState.strongAddsBySide[state.slugState.anchorSide || leader]} cheapOpp=${state.slugState.anchorSide ? state.slugState.cheapAddsBySide[state.slugState.anchorSide === 'up' ? 'down' : 'up'] : 0} | upLots=${totals.up.qty.toFixed(0)} downLots=${totals.down.qty.toFixed(0)}`;
}

function determineWinnerFromLive() {
  const up = currentMid('up');
  const down = currentMid('down');
  if (Number.isFinite(up) && Number.isFinite(down) && Math.abs(up - down) > 0.05) return up > down ? 'up' : 'down';
  return null;
}

async function determineWinnerFresh(slug) {
  try {
    const fresh = await fetchMarketBySlug(slug);
    const winner = extractWinnerFromMarketObj(fresh);
    if (winner) return winner;
  } catch (err) {
    addScreenLog(`winner fetch failed ${slug}: ${err.message}`);
  }
  return determineWinnerFromLive();
}

async function settleExpiredSlug() {
  if (!state.slug || !state.endDate) return;
  const endSec = Math.floor(new Date(state.endDate).getTime() / 1000);
  if (!Number.isFinite(endSec)) return;
  if (nowSec() < endSec + CONFIG.resolveGraceSec) return;

  const openLots = currentOpenLotsForSlug(state.slug);
  if (!openLots.length) return;

  const winner = await determineWinnerFresh(state.slug);
  if (!winner) {
    state.strategy.status = 'UNRESOLVED';
    state.strategy.reason = 'Slug ended but winner still unknown';
    return;
  }

  let totalPnl = 0;
  let totalQty = 0;
  const survivors = [];

  for (const lot of state.paper.openLots) {
    if (lot.slug !== state.slug) {
      survivors.push(lot);
      continue;
    }

    const payout = lot.side === winner ? lot.qty : 0;
    const pnl = payout - lot.entryUsd;
    totalPnl += pnl;
    totalQty += lot.qty;
    state.paper.realizedPnl += pnl;
    state.paper.lockedCapital = Math.max(0, state.paper.lockedCapital - lot.entryUsd);
    state.paper.claimableCash += payout;
    state.paper.totalSettled += 1;
    if (pnl >= 0) state.paper.wins += 1;
    else state.paper.losses += 1;

    state.paper.closedLots.push({
      slug: lot.slug,
      side: lot.side,
      qty: lot.qty,
      entryPrice: lot.entryPrice,
      exitPrice: lot.side === winner ? 1 : 0,
      entryUsd: lot.entryUsd,
      exitUsd: payout,
      pnl,
      openedAtSec: lot.openedAtSec,
      closedAtSec: nowSec(),
      source: lot.source,
      reason: lot.reason,
      closeReason: 'slug-settlement',
      label: lot.label,
    });

    pushRecentAction(createActionSummary('SETTLE', lot.side, lot.entryPrice, lot.qty, payout, lot.source, `winner=${winner.toUpperCase()}`));
    logEvent([
      'PAPER_SETTLE',
      `slug=${lot.slug}`,
      `label=${lot.label}`,
      `winner=${winner.toUpperCase()}`,
      `lot_side=${lot.side.toUpperCase()}`,
      `shares=${lot.qty.toFixed(4)}`,
      `entry_px=${lot.entryPrice.toFixed(4)}`,
      `payout=${payout.toFixed(2)}`,
      `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
      `source=${lot.source}`,
    ].join(' | '), lot.slug);
  }

  state.paper.openLots = survivors;
  if (state.paper.claimableCash > 0) {
    state.paper.availableCash += state.paper.claimableCash;
    logEvent(`CLAIM_PAYOUT | slug=${state.slug} | amount=${state.paper.claimableCash.toFixed(2)}`, state.slug);
    state.paper.claimableCash = 0;
  }

  state.paper.slugHistory.push({
    slug: state.slug,
    label: state.marketLabel,
    winner,
    pnl: totalPnl,
    totalShares: totalQty,
    anchorSide: state.slugState.anchorSide,
    flipsUsed: state.slugState.flipsUsed,
    strongUp: state.slugState.strongAddsBySide.up,
    strongDown: state.slugState.strongAddsBySide.down,
    cheapUp: state.slugState.cheapAddsBySide.up,
    cheapDown: state.slugState.cheapAddsBySide.down,
    probeUp: state.slugState.probeAddsBySide.up,
    probeDown: state.slugState.probeAddsBySide.down,
  });
  while (state.paper.slugHistory.length > 60) state.paper.slugHistory.shift();

  logEvent(`SLUG_PROFILE | slug=${state.slug} | anchor=${state.slugState.anchorSide ? state.slugState.anchorSide.toUpperCase() : '-'} | flips=${state.slugState.flipsUsed} | probe_up=${state.slugState.probeAddsBySide.up} | probe_down=${state.slugState.probeAddsBySide.down} | strong_up=${state.slugState.strongAddsBySide.up} | strong_down=${state.slugState.strongAddsBySide.down} | cheap_up=${state.slugState.cheapAddsBySide.up} | cheap_down=${state.slugState.cheapAddsBySide.down} | pnl=${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`, state.slug);
  logEvent(`SLUG_SETTLED | slug=${state.slug} | winner=${winner.toUpperCase()} | total_shares=${totalQty.toFixed(4)} | total_pnl=${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`, state.slug);
  state.strategy.status = 'SETTLED';
  state.strategy.reason = `winner=${winner.toUpperCase()} total_pnl=${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`;
}

function formatLocalDateTimeFromSec(tsSec) {
  if (!Number.isFinite(tsSec)) return '-';
  const d = new Date(Number(tsSec) * 1000);
  const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/AM/g, 'am').replace(/PM/g, 'pm');
  return `${date}, ${time}`;
}

function visibleLen(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padVisible(text, width, align = 'left') {
  const raw = String(text || '');
  const diff = Math.max(0, width - visibleLen(raw));
  if (align === 'right') return ' '.repeat(diff) + raw;
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    return ' '.repeat(left) + raw + ' '.repeat(diff - left);
  }
  return raw + ' '.repeat(diff);
}

function sideText(side, width = 4) {
  return colorSide(side, String(side || '').toUpperCase().padEnd(width));
}


function previousSlugTokens(limit = 60, useColor = true) {
  const hist = (state.paper.slugHistory || []).slice(-limit);
  return hist.map((x, idx) => {
    const rounded = Math.round(Number(x.pnl || 0));
    const raw = `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded)}`;
    const token = padVisible(raw, 4, 'right');
    if (!useColor) return token;
    return idx === hist.length - 1 ? colorBlue(token) : colorPnl(rounded, token);
  });
}

function previousSlugsGrid(limit = 60, useColor = true) {
  const toks = previousSlugTokens(limit, useColor);
  if (!toks.length) return ['Previous slugs: none'];
  const rows = [];
  for (let i = 0; i < toks.length; i += 20) {
    const chunk = toks.slice(i, i + 20);
    rows.push(`Previous slugs: ${chunk.join(' | ')}`);
  }
  while (rows.length < 3) rows.push('Previous slugs:');
  return rows;
}

function currentSlugOpenPnl(lots) {
  let pnl = 0;
  for (const lot of lots || []) {
    const mid = lot.side === 'up' ? currentMid('up') : currentMid('down');
    if (!Number.isFinite(mid)) continue;
    pnl += (lot.qty * mid) - lot.entryUsd;
  }
  return pnl;
}

function totalsLineForLots(lots, useColor = false) {
  const totals = totalsBySide(lots);
  const pnl = currentSlugOpenPnl(lots);
  const upLabel = useColor ? colorSide('up', 'UP'.padEnd(4)) : 'UP'.padEnd(4);
  const downLabel = useColor ? colorSide('down', 'DOWN'.padEnd(4)) : 'DOWN'.padEnd(4);
  const pnlText = useColor ? colorPnl(pnl, `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`) : `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
  return `${upLabel} total ${totals.up.qty.toFixed(4)} sh | usd ${fmtUsd(totals.up.usd)}   ${downLabel} total ${totals.down.qty.toFixed(4)} sh | usd ${fmtUsd(totals.down.usd)} | current slug p&l=${pnlText}`;
}

function lockedExplanation() {
  return 'Locked = cash tied to open paper lots in the active slug until settlement and payout claim.';
}

function formatOpenLotLine(lot, idx) {
  const idxTxt = padVisible(`${idx + 1}.`, 4, 'right');
  const sideTxt = padVisible(sideText(lot.side, 4), 4);
  const qtyTxt = padVisible(`${lot.qty.toFixed(4)} sh`, 11, 'right');
  const entryTxt = padVisible(`entry ${fmtPrice(lot.entryPrice)}`, 10);
  const usdTxt = padVisible(`usd ${fmtUsd(lot.entryUsd)}`, 11);
  const tTxt = padVisible(`t ${fmtMmSs(lot.minuteInSlugSec)}`, 8);
  const openedTxt = padVisible(`opened ${formatLocalDateTimeFromSec(lot.openedAtSec)}`, 28);
  const sourceTxt = padVisible(`source ${lot.source}`, 20);
  return `  ${idxTxt} ${sideTxt} | ${qtyTxt} | ${entryTxt} | ${usdTxt} | ${tTxt} | ${openedTxt} | ${sourceTxt}`;
}

function formatRecentActionLine(ev, idx) {
  const idxTxt = padVisible(`${idx + 1}.`, 4, 'right');
  const kindTxt = padVisible(String(ev.kind || '').toUpperCase(), 6);
  const sideTxt = padVisible(sideText(ev.side, 4), 4);
  const pxTxt = padVisible(`px ${fmtPrice(ev.price)}`, 8);
  const shTxt = padVisible(`sh ${Number(ev.qty || 0).toFixed(4)}`, 12);
  const usdTxt = padVisible(`usd ${fmtUsd(ev.usd)}`, 11);
  const tTxt = padVisible(`t ${fmtMmSs(ev.elapsed)}`, 8);
  const slugTxt = displaySlugLabel(ev.slug, ev.label);
  const sourceTxt = padVisible(ev.source || '-', 12);
  return `  ${idxTxt} ${kindTxt} ${sideTxt} | ${pxTxt} | ${shTxt} | ${usdTxt} | ${tTxt} | ${slugTxt} | ${sourceTxt}`;
}

function writeSummaryFiles() {
  const lines = [];
  lines.push(BOT_TITLE);
  lines.push(`Updated: ${nowIso()}`);
  lines.push(`Session time: ${fmtMmSs(sessionElapsedSec())}`);
  lines.push(`Strategy idea: conservative anchored bias + smaller cheap hedges + strict chase control + settlement hold`);
  lines.push(`Bankroll start: ${fmtUsd(state.paper.bankrollStart)}`);
  lines.push(`Available cash: ${fmtUsd(state.paper.availableCash)}`);
  lines.push(`Locked capital: ${fmtUsd(state.paper.lockedCapital)}`);
  lines.push(`Locked explanation: ${lockedExplanation()}`);
  lines.push(`Realized PnL: ${state.paper.realizedPnl >= 0 ? '+' : ''}${state.paper.realizedPnl.toFixed(2)}`);
  lines.push(`Slugs W/L: ${state.paper.wins}W | ${state.paper.losses}L`);
  lines.push(`Total buys: ${state.paper.totalBuys}`);
  lines.push(`Settled lots: ${state.paper.totalSettled}`);
  lines.push(...previousSlugsGrid(60, false));
  lines.push('');
  lines.push(`Open Lots${state.slug ? ` | ${displaySlugLabel(state.slug, state.marketLabel)}` : ''}`);
  const orderedLots = state.paper.openLots.slice().sort((a, b) => a.openedAtSec - b.openedAtSec || String(a.id).localeCompare(String(b.id)));
  lines.push(`  Totals: ${stripAnsi(totalsLineForLots(orderedLots, false))}`);
  if (!state.paper.openLots.length) lines.push('  none');
  orderedLots.forEach((lot, idx) => {
    lines.push(stripAnsi(formatOpenLotLine(lot, idx)));
  });
  fs.writeFileSync(state.paths.summaryFile, lines.join('\n'), 'utf8');
}

function writeStatusSnapshot() {
  const timer = slugTimerInfo();
  const upPx = currentMid('up');
  const downPx = currentMid('down');
  const openLots = currentOpenLotsForSlug(state.slug);
  const recent = state.recentActions.slice(-10).reverse();
  const lines = [];
  lines.push(BOT_TITLE);
  lines.push(`Updated: ${nowIso()}`);
  lines.push(`Session time: ${fmtMmSs(sessionElapsedSec())}`);
  lines.push(`Active slug: ${state.slug || '-'}`);
  lines.push(`Active label: ${state.slug ? displaySlugLabel(state.slug, state.marketLabel) : '-'}`);
  lines.push(`Elapsed: ${timer ? fmtMmSs(timer.elapsedSec) : '-'}`);
  lines.push(`Rollover in: ${timer ? fmtMmSs(timer.remainingSec) : '-'}`);
  lines.push(`UP mid: ${Number.isFinite(upPx) ? upPx.toFixed(4) : '-'}`);
  lines.push(`DOWN mid: ${Number.isFinite(downPx) ? downPx.toFixed(4) : '-'}`);
  lines.push(`Leader: ${state.strategy.leader ? state.strategy.leader.toUpperCase() : '-'} ${Number.isFinite(state.strategy.leaderPrice) ? fmtPrice(state.strategy.leaderPrice) : '-'}`);
  lines.push(`Laggard: ${state.strategy.laggard ? state.strategy.laggard.toUpperCase() : '-'} ${Number.isFinite(state.strategy.laggardPrice) ? fmtPrice(state.strategy.laggardPrice) : '-'}`);
  lines.push(`Anchor: ${state.strategy.anchorSide ? state.strategy.anchorSide.toUpperCase() : '-'} | streak ${fmtMmSs(state.strategy.anchorStreakSec || 0)} | flips ${state.slugState.flipsUsed} | allowFlip=${CONFIG.allowFlip ? 'ON' : 'OFF'}`);
  lines.push(`Score: ${state.strategy.score}`);
  lines.push(`Status: ${state.strategy.status}`);
  lines.push(`Reason: ${state.strategy.reason}`);
  lines.push(`Last action: ${state.strategy.lastAction}`);
  lines.push(`Balance: available=${fmtUsd(state.paper.availableCash)} | locked=${fmtUsd(state.paper.lockedCapital)} | realized=${state.paper.realizedPnl >= 0 ? '+' : ''}${state.paper.realizedPnl.toFixed(2)}`);
  lines.push(`Stats: session=${fmtMmSs(sessionElapsedSec())} | buys=${state.paper.totalBuys} | settled=${state.paper.totalSettled} | Slugs ${state.paper.wins}W | ${state.paper.losses}L`);
  lines.push(...previousSlugsGrid(60, false));
  lines.push('');
  lines.push('Recent strategy actions');
  if (!recent.length) lines.push('  none');
  let prevSlug = null;
  recent.forEach((ev, idx) => {
    if (prevSlug && prevSlug !== ev.slug) lines.push('');
    lines.push(stripAnsi(formatRecentActionLine(ev, idx)));
    prevSlug = ev.slug;
  });
  lines.push('');
  lines.push(`Open lots for active slug${state.slug ? ` | ${displaySlugLabel(state.slug, state.marketLabel)}` : ''}`);
  lines.push(`  Totals: ${stripAnsi(totalsLineForLots(openLots, false))}`);
  if (!openLots.length) lines.push('  none');
  openLots.forEach((lot, idx) => {
    lines.push(stripAnsi(formatOpenLotLine(lot, idx)));
  });

  fs.writeFileSync(state.paths.statusFile, lines.join('\n'), 'utf8');
  writeSummaryFiles();

  if (state.slug) {
    const perSlugStatus = path.join(CONFIG.exportDir, 'slug_logs', `${slugFileBase(state.slug)}__status.txt`);
    fs.writeFileSync(perSlugStatus, lines.join('\n'), 'utf8');
  }
}

function render() {
  if (!CONFIG.screen) return;
  const now = Date.now();
  if (now - state.lastRender < CONFIG.renderMs) return;
  state.lastRender = now;

  const timer = slugTimerInfo();
  const upPx = currentMid('up');
  const downPx = currentMid('down');
  const openLots = currentOpenLotsForSlug(state.slug);
  const recent = state.recentActions.slice(-8).reverse();
  const parts = state.strategy.components || {};
  const balanceLine = `${colorYellow(`Balance: available=${fmtUsd(state.paper.availableCash)} | locked=${fmtUsd(state.paper.lockedCapital)}`)} | ${colorRealized(state.paper.realizedPnl)}`;

  const lines = [];
  lines.push(`${ANSI.bold}${BOT_TITLE}${ANSI.reset}`);
  lines.push(`${ANSI.gray}Model:${ANSI.reset} anchored bias + flip ${CONFIG.allowFlip ? 'ON' : 'OFF'} + smaller cheap hedge + settlement hold`);
  lines.push('');
  lines.push(`Slug: ${state.slug || '-'} | ${state.slug ? displaySlugLabel(state.slug, state.marketLabel) : '-'}`);
  lines.push(`Slug Timer: | Elapsed: ${timer ? fmtMmSs(timer.elapsedSec) : '-'} | ${colorBlue(`Rollover in ${timer ? fmtMmSs(timer.remainingSec) : '-'}`)}`);
  lines.push(`Prices: ${colorSide('up', `UP=${fmtPrice(upPx)}`)}  ${colorSide('down', `DOWN=${fmtPrice(downPx)}`)}`);
  lines.push(`Bias: leader=${state.strategy.leader ? colorSide(state.strategy.leader, state.strategy.leader.toUpperCase()) : '-'} ${Number.isFinite(state.strategy.leaderPrice) ? fmtPrice(state.strategy.leaderPrice) : '-'} | laggard=${state.strategy.laggard ? colorSide(state.strategy.laggard, state.strategy.laggard.toUpperCase()) : '-'} ${Number.isFinite(state.strategy.laggardPrice) ? fmtPrice(state.strategy.laggardPrice) : '-'} | anchor=${state.strategy.anchorSide ? colorSide(state.strategy.anchorSide, state.strategy.anchorSide.toUpperCase()) : '-'} | score=${state.strategy.score}`);
  lines.push(`Momentum: edge=${Number.isFinite(parts.edge) ? fmtPrice(parts.edge) : '-'} | leader20=${Number.isFinite(parts.leaderM20) ? fmtPrice(parts.leaderM20) : '-'} | leader45=${Number.isFinite(parts.leaderM45) ? fmtPrice(parts.leaderM45) : '-'} | lag20=${Number.isFinite(parts.laggardM20) ? fmtPrice(parts.laggardM20) : '-'} | streak=${fmtMmSs(state.slugState.leaderStreakSec || 0)} | flips=${state.slugState.flipsUsed}/${CONFIG.allowFlip ? 1 : 0}`);
  lines.push('');
  lines.push(`Status: ${state.strategy.status} | ${state.strategy.reason}`);
  lines.push(`Status session: ${fmtMmSs(sessionElapsedSec())}`);
  lines.push(`Last action: ${state.strategy.lastAction}`);
  lines.push(balanceLine);
  lines.push(`Stats: session=${fmtMmSs(sessionElapsedSec())} | buys=${state.paper.totalBuys} | settled=${state.paper.totalSettled} | Slugs ${ANSI.green}${state.paper.wins}W${ANSI.reset} | ${ANSI.red}${state.paper.losses}L${ANSI.reset}`);
  lines.push(...previousSlugsGrid(60, true));
  lines.push('');
  lines.push(`Open lots for active slug: ${state.slug ? displaySlugLabel(state.slug, state.marketLabel) : '-'}`);
  lines.push(`  Totals: ${totalsLineForLots(openLots, true)}`);
  if (!openLots.length) lines.push('  none');
  openLots.forEach((lot, idx) => {
    lines.push(formatOpenLotLine(lot, idx));
  });
  lines.push('');
  lines.push('Recent strategy actions:');
  if (!recent.length) lines.push('  none');
  let prevSlug = null;
  recent.forEach((ev, idx) => {
    if (prevSlug && prevSlug !== ev.slug) lines.push('');
    lines.push(formatRecentActionLine(ev, idx));
    prevSlug = ev.slug;
  });
  lines.push('');
  lines.push('Live log:');
  for (const line of state.logLines.slice(-8)) lines.push(`  ${line}`);
  lines.push('');
  lines.push(balanceLine);

  process.stdout.write('\x1Bc');
  process.stdout.write(lines.join('\n') + '\n');
}

function handleWsMessage(raw) {
  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    return;
  }
  const items = Array.isArray(payload) ? payload : [payload];
  let touched = false;

  for (const item of items) {
    const eventType = item.event_type || item.type || item.channel;
    const assetId = String(item.asset_id || item.assetId || item.token_id || '');

    if (eventType === 'book') {
      const book = assetId === state.upToken ? state.upBook : assetId === state.downToken ? state.downBook : null;
      if (!book) continue;
      book.bids = [];
      book.asks = [];
      for (const x of (item.bids || [])) {
        const p = Number(x.price);
        const sz = Number(x.size);
        if (Number.isFinite(p) && Number.isFinite(sz)) book.bids.push({ price: p, size: sz });
      }
      for (const x of (item.asks || [])) {
        const p = Number(x.price);
        const sz = Number(x.size);
        if (Number.isFinite(p) && Number.isFinite(sz)) book.asks.push({ price: p, size: sz });
      }
      sortBook(book);
      touched = true;
      continue;
    }

    if (eventType === 'best_bid_ask') {
      const book = assetId === state.upToken ? state.upBook : assetId === state.downToken ? state.downBook : null;
      if (!book) continue;
      const bid = Number(item.best_bid);
      const ask = Number(item.best_ask);
      const bidSz = Number(item.best_bid_size || 0);
      const askSz = Number(item.best_ask_size || 0);
      if (Number.isFinite(bid) && Number.isFinite(ask)) {
        book.bids = [{ price: bid, size: bidSz }].concat(book.bids.slice(1));
        book.asks = [{ price: ask, size: askSz }].concat(book.asks.slice(1));
        touched = true;
      }
      continue;
    }

    if (eventType === 'last_trade_price' || eventType === 'trade' || eventType === 'price_change') {
      const px = Number(item.price || item.last_trade_price);
      if (!Number.isFinite(px)) continue;
      if (assetId === state.upToken) pushLimited(state.upTradeHistory, { ts: nowSec(), value: px }, CONFIG.historyMax);
      if (assetId === state.downToken) pushLimited(state.downTradeHistory, { ts: nowSec(), value: px }, CONFIG.historyMax);
      touched = true;
    }
  }

  if (touched) recordMidHistory();
}

function connectWs() {
  if (!state.upToken || !state.downToken) return;
  if (state.ws) {
    try { state.ws.terminate(); } catch {}
  }

  const ws = new WebSocket(WS_MARKET_URL);
  state.ws = ws;

  ws.on('open', () => {
    ws.send(JSON.stringify({ assets_ids: [state.upToken, state.downToken], type: 'market', custom_feature_enabled: true }));
    addScreenLog(`ws subscribed ${state.slug}`);
  });

  ws.on('message', (data) => handleWsMessage(data));
  ws.on('close', (code) => {
    addScreenLog(`ws closed (${code})`);
    if (state.ws === ws) {
      setTimeout(() => {
        if (state.slug) connectWs();
      }, 3000);
    }
  });
  ws.on('error', (err) => addScreenLog(`ws error: ${err.message}`));
}

async function loadMarket(market) {
  const nextSlug = String(market.slug || '');
  if (!nextSlug) return;
  if (state.slug === nextSlug && state.upToken && state.downToken) return;

  state.slug = nextSlug;
  state.question = String(market.question || market.title || nextSlug);
  state.endDate = String(market.endDate || market.end_date || '');
  state.marketId = market.id || market.market_id || null;
  const [upToken, downToken] = extractTokenIds(market);
  state.upToken = upToken;
  state.downToken = downToken;
  state.marketLabel = chartMarketLabel(state.slug, state.endDate);
  resetSlugState();
  logEvent(`ACTIVE_SLUG | slug=${state.slug} | label=${state.marketLabel}`, state.slug);
  connectWs();
}

async function initMarket() {
  let market = null;
  if (CONFIG.slug) market = await fetchMarketBySlug(CONFIG.slug);
  else if (state.slug) {
    try { market = await fetchMarketBySlug(state.slug); } catch {}
  }
  if (!market && CONFIG.autoDiscover) market = await discoverCurrentMarket();
  if (!market) throw new Error('No market found. Pass --slug or enable auto discovery.');
  await loadMarket(market);
}

async function monitorMarkets() {
  if (!CONFIG.autoDiscover) return;
  const market = await discoverCurrentMarket();
  if (!market) return;
  const slug = String(market.slug || '');
  if (!state.slug || state.slug !== slug) await loadMarket(market);
}

function shutdown(reason) {
  try {
    writeStatusSnapshot();
    saveCheckpoint();
    logEvent(`SHUTDOWN | ${reason}`, state.slug);
  } catch {}
  releaseInstanceLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  acquireInstanceLock();
  loadCheckpoint();
  logEvent(`BOOT_V3_1 | bankroll=${CONFIG.bankroll} | shares=${CONFIG.shares} | allow_flip=${CONFIG.allowFlip ? 'on' : 'off'} | export_dir=${CONFIG.exportDir}`);
  await initMarket();
  writeStatusSnapshot();
  saveCheckpoint();
  render();

  setInterval(() => {
    monitorMarkets().catch((err) => logEvent(`MARKET_POLL_ERROR | ${err.message}`, state.slug));
  }, CONFIG.marketPollMs);

  setInterval(() => {
    recordMidHistory();
    strategyTick();
    settleExpiredSlug().catch((err) => logEvent(`SETTLE_ERROR | ${err.message}`, state.slug));
    writeStatusSnapshot();
    saveCheckpoint();
    render();
  }, CONFIG.tickMs);

  setInterval(() => {
    render();
  }, CONFIG.renderMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
