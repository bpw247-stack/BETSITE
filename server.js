'use strict';

// BetSite server: zero-dependency Node HTTP server.
// - Serves the static frontend from ./public
// - Stores bets, general notes and team notes in ./data/db.json
// - Proxies (and caches) NFL/NBA injury reports from ESPN's public API

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseEspnInjuries } = require('./lib/injuries');
const { parseEspnScoreboard, espnDay } = require('./lib/schedule');
const { seasonsToSearch, meetingsFromSchedule, parseGameSummary, summarizeH2H } = require('./lib/h2h');
const { createUpdater } = require('./lib/updater');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INJURY_TTL_MS = 15 * 60 * 1000;
const SCHEDULE_TTL_MS = 10 * 60 * 1000;
const LIVE_SCHEDULE_TTL_MS = 60 * 1000; // while a game is in progress, keep scores fresh
const UPDATE_CHECK_TTL_MS = 10 * 60 * 1000;
const RESTART_CODE = 75; // start.js relaunches the server when it exits with this code

const updater = createUpdater({ appDir: __dirname, dataDir: path.dirname(DATA_FILE) });
let updateCheckCache = null;
const BOOT_ID = crypto.randomUUID(); // changes on every restart, so the page can tell the new server is up

const COLLECTIONS = ['bets', 'notes', 'teamNotes'];
const LEAGUE_PATHS = { nfl: 'football/nfl', nba: 'basketball/nba' };

// ---------- storage ----------

function emptyDb() {
  return { bets: [], notes: [], teamNotes: [] };
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
    return db;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file, starting empty:', err.message);
    return emptyDb();
  }
}

let db = loadDb();

function saveDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) =>
        e2 ? send(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
      );
    }
    // no-cache: the browser revalidates every time, so a freshly installed version shows up immediately
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ---------- injuries ----------

const injuryCache = {}; // league -> { at, data }

async function getInjuries(league, force) {
  const cached = injuryCache[league];
  if (!force && cached && Date.now() - cached.at < INJURY_TTL_MS) return { ...cached.data, cached: true };
  const url = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE_PATHS[league]}/injuries`;
  const r = await fetch(url, { headers: { 'User-Agent': 'BetSite/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
  const data = { league, fetchedAt: new Date().toISOString(), teams: parseEspnInjuries(await r.json()) };
  injuryCache[league] = { at: Date.now(), data };
  return { ...data, cached: false };
}

// ---------- schedule ----------

const scheduleCache = {}; // `${league}:${days}` -> { at, data }

async function getSchedule(league, days, force) {
  const key = `${league}:${days}`;
  const cached = scheduleCache[key];
  const ttl = cached && cached.data.games.some((g) => g.state === 'in') ? LIVE_SCHEDULE_TTL_MS : SCHEDULE_TTL_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return { ...cached.data, cached: true };
  const now = new Date();
  const dayList = Array.from({ length: days }, (_, i) => espnDay(new Date(now.getTime() + i * 86400000)));
  const range = `${dayList[0]}-${dayList[dayList.length - 1]}`;

  // ESPN accepts a date range for some leagues/endpoints but rejects it (400) for others,
  // so try the range first and fall back to one request per day.
  let payloads;
  try {
    payloads = [await espnJson(league, `scoreboard?dates=${days === 1 ? dayList[0] : range}`)];
  } catch (rangeErr) {
    const perDay = await Promise.allSettled(dayList.map((d) => espnJson(league, `scoreboard?dates=${d}`)));
    payloads = perDay.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!payloads.length) {
      // last resort: the default scoreboard (today / the current NFL week)
      try {
        payloads = [await espnJson(league, 'scoreboard')];
      } catch {
        throw rangeErr;
      }
    }
  }

  const seen = new Set();
  const games = payloads
    .flatMap((p) => parseEspnScoreboard(p))
    .filter((g) => !seen.has(g.id) && seen.add(g.id))
    .sort((a, b) => a.date.localeCompare(b.date));
  const data = { league, days, range, fetchedAt: new Date().toISOString(), games };
  scheduleCache[key] = { at: Date.now(), data };
  return { ...data, cached: false };
}

// ---------- head-to-head ----------

const H2H_TTL_MS = 6 * 60 * 60 * 1000;
const h2hCache = {}; // `${league}:${a}:${b}` -> { at, data }
const summaryCache = new Map(); // event id -> parsed summary (finished games never change)

async function espnJson(league, pathAndQuery) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE_PATHS[league]}/${pathAndQuery}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'BetSite/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    console.warn(`ESPN ${r.status}: ${url}`);
    throw new Error(`ESPN responded ${r.status}`);
  }
  return r.json();
}

async function getH2H(league, a, b, n, force) {
  const key = `${league}:${a}:${b}:${n}`;
  const cached = h2hCache[key];
  if (!force && cached && Date.now() - cached.at < H2H_TTL_MS) return cached.data;

  // 1. find past meetings in team A's schedules (regular season + playoffs)
  const lookups = seasonsToSearch(league).flatMap((season) => [2, 3].map((type) => ({ season, type })));
  const results = await Promise.allSettled(
    lookups.map(({ season, type }) => espnJson(league, `teams/${encodeURIComponent(a.toLowerCase())}/schedule?season=${season}&seasontype=${type}`))
  );
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
  const seen = new Set();
  const meetings = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => meetingsFromSchedule(r.value, b))
    .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((x, y) => y.date.localeCompare(x.date))
    .slice(0, n);

  // 2. box score + leaders for each meeting
  const games = (
    await Promise.all(
      meetings.map(async (m) => {
        if (!summaryCache.has(m.id)) {
          try {
            const g = parseGameSummary(await espnJson(league, `summary?event=${encodeURIComponent(m.id)}`), league);
            if (g) summaryCache.set(m.id, { ...g, id: m.id, postseason: m.postseason });
          } catch {
            return null;
          }
        }
        return summaryCache.get(m.id) || null;
      })
    )
  ).filter(Boolean);
  if (summaryCache.size > 2000) summaryCache.delete(summaryCache.keys().next().value);

  const data = { league, a, b, fetchedAt: new Date().toISOString(), summary: summarizeH2H(games, a, b), games };
  h2hCache[key] = { at: Date.now(), data };
  return data;
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const [resource, id] = parts;

  if (resource === 'injuries') {
    const league = (id || '').toLowerCase();
    if (!LEAGUE_PATHS[league]) return send(res, 404, { error: 'Unknown league' });
    try {
      return send(res, 200, await getInjuries(league, url.searchParams.has('refresh')));
    } catch (err) {
      const stale = injuryCache[league];
      if (stale) return send(res, 200, { ...stale.data, cached: true, stale: true, error: err.message });
      return send(res, 502, { error: `Could not load ${league.toUpperCase()} injuries: ${err.message}` });
    }
  }

  if (resource === 'schedule') {
    const league = (id || '').toLowerCase();
    if (!LEAGUE_PATHS[league]) return send(res, 404, { error: 'Unknown league' });
    const days = Math.min(21, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 7));
    try {
      return send(res, 200, await getSchedule(league, days, url.searchParams.has('refresh')));
    } catch (err) {
      const stale = scheduleCache[`${league}:${days}`];
      if (stale) return send(res, 200, { ...stale.data, cached: true, stale: true, error: err.message });
      return send(res, 502, { error: `Could not load ${league.toUpperCase()} schedule: ${err.message}` });
    }
  }

  if (resource === 'h2h') {
    const league = (id || '').toLowerCase();
    const a = String(url.searchParams.get('a') || '').toUpperCase();
    const b = String(url.searchParams.get('b') || '').toUpperCase();
    if (!LEAGUE_PATHS[league]) return send(res, 404, { error: 'Unknown league' });
    if (!/^[A-Z]{2,4}$/.test(a) || !/^[A-Z]{2,4}$/.test(b) || a === b) return send(res, 400, { error: 'Pass two different team abbreviations as ?a=&b=' });
    const n = Math.min(10, Math.max(1, parseInt(url.searchParams.get('n'), 10) || 5));
    try {
      return send(res, 200, await getH2H(league, a, b, n, url.searchParams.has('refresh')));
    } catch (err) {
      return send(res, 502, { error: `Could not load previous matchups: ${err.message}` });
    }
  }

  if (resource === 'version' && req.method === 'GET') {
    const v = updater.installed();
    return send(res, 200, { sha: v ? v.sha : null, installedAt: v ? v.installedAt : null, boot: BOOT_ID, autoRestart: process.env.BETSITE_LAUNCHER === '1' });
  }

  if (resource === 'update' && id === 'check' && req.method === 'GET') {
    const force = url.searchParams.has('refresh');
    if (force || !updateCheckCache || Date.now() - updateCheckCache.at > UPDATE_CHECK_TTL_MS) {
      try {
        updateCheckCache = { at: Date.now(), data: await updater.check() };
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    return send(res, 200, { ...updateCheckCache.data, autoRestart: process.env.BETSITE_LAUNCHER === '1' });
  }

  if (resource === 'update' && id === 'apply' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await updater.apply(body.sha);
      updateCheckCache = null;
      const autoRestart = process.env.BETSITE_LAUNCHER === '1';
      send(res, 200, { ok: true, ...result, restarting: autoRestart });
      console.log(`Installed BetSite version ${result.sha.slice(0, 7)} (${result.files} files).`);
      if (autoRestart) setTimeout(() => process.exit(RESTART_CODE), 300);
      else console.log('Restart BetSite to finish the update: press Control+C, then run npm start.');
      return;
    } catch (err) {
      return send(res, 500, { error: `Update failed: ${err.message}` });
    }
  }

  if (resource === 'export' && req.method === 'GET') {
    return send(res, 200, db, { 'Content-Disposition': 'attachment; filename="betsite-backup.json"' });
  }

  if (resource === 'import' && req.method === 'POST') {
    const body = await readBody(req);
    const next = emptyDb();
    for (const c of COLLECTIONS) if (Array.isArray(body[c])) next[c] = body[c].filter((x) => x && x.id);
    db = next;
    saveDb();
    return send(res, 200, { ok: true, counts: Object.fromEntries(COLLECTIONS.map((c) => [c, db[c].length])) });
  }

  if (!COLLECTIONS.includes(resource)) return send(res, 404, { error: 'Not found' });
  const list = db[resource];

  if (!id) {
    if (req.method === 'GET') return send(res, 200, list);
    if (req.method === 'POST') {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const item = { ...body, id: body.id && !list.some((x) => x.id === body.id) ? String(body.id) : crypto.randomUUID(), createdAt: now, updatedAt: now };
      list.push(item);
      saveDb();
      return send(res, 201, item);
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const idx = list.findIndex((x) => x.id === id);
  if (req.method === 'PUT' && idx === -1 && resource === 'teamNotes') {
    // team notes are keyed by "league-abbr" and created on first save
    const body = await readBody(req);
    const now = new Date().toISOString();
    const item = { ...body, id, createdAt: now, updatedAt: now };
    list.push(item);
    saveDb();
    return send(res, 200, item);
  }
  if (idx === -1) return send(res, 404, { error: 'Not found' });

  if (req.method === 'GET') return send(res, 200, list[idx]);
  if (req.method === 'PUT') {
    const body = await readBody(req);
    list[idx] = { ...list[idx], ...body, id, createdAt: list[idx].createdAt, updatedAt: new Date().toISOString() };
    saveDb();
    return send(res, 200, list[idx]);
  }
  if (req.method === 'DELETE') {
    list.splice(idx, 1);
    saveDb();
    return send(res, 204, '');
  }
  return send(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: err.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`BetSite running at http://localhost:${PORT}  (data: ${DATA_FILE})`);
  });
}

module.exports = { server };
