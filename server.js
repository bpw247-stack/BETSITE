'use strict';

// BetSite server: zero-dependency Node HTTP server.
// - Serves the static frontend from ./public
// - Stores bets, general notes and team notes in ./data/db.json
// - Proxies (and caches) NFL/NBA injury reports from ESPN's public API

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { parseEspnInjuries } = require('./lib/injuries');
const { parseEspnScoreboard, espnDay } = require('./lib/schedule');
const { seasonsToSearch, meetingsFromSchedule, parseGameSummary, summarizeH2H } = require('./lib/h2h');
const { createUpdater } = require('./lib/updater');
const niche = require('./lib/niche');
const grading = require('./lib/grading');
const weather = require('./lib/weather');
const trends = require('./lib/trends');
const { createAuth, isLocalRequest, loginPage, blockedPage } = require('./lib/auth');

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
const auth = createAuth({ dataDir: path.dirname(DATA_FILE) });
let updateCheckCache = null;
const BOOT_ID = crypto.randomUUID(); // changes on every restart, so the page can tell the new server is up

const COLLECTIONS = ['bets', 'notes', 'teamNotes', 'coaches', 'settings'];
const LEAGUE_PATHS = { nfl: 'football/nfl', nba: 'basketball/nba' };

// ---------- storage ----------

function emptyDb() {
  return { bets: [], notes: [], teamNotes: [], coaches: [], settings: [] };
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

// ---------- niche stats ----------

const NICHE_TTL_MS = 6 * 60 * 60 * 1000;
const nicheCache = {}; // `${league}:${team}` -> { at, data }
const ATS_WINDOW = { nfl: 40, nba: 30 }; // most recent games to look up closing lines for

// Closing lines of finished games never change, so keep them on disk between restarts.
const lineCaches = {};
function lineCache(league) {
  if (!lineCaches[league]) {
    const file = path.join(path.dirname(DATA_FILE), 'cache', `lines-${league}.json`);
    let map = {};
    try {
      map = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    lineCaches[league] = {
      map,
      save() {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(map));
        } catch (err) {
          console.warn('Could not save line cache:', err.message);
        }
      },
    };
  }
  return lineCaches[league];
}

// Run async tasks with limited concurrency (be gentle with ESPN).
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

async function getTeamNiche(league, team, force) {
  const key = `${league}:${team}`;
  const cached = nicheCache[key];
  if (!force && cached && Date.now() - cached.at < NICHE_TTL_MS) return cached.data;

  const seasons = niche.nicheSeasons(league);
  const lookups = seasons.flatMap((season) => [2, 3].map((type) => ({ season, type })));
  const slug = encodeURIComponent(team.toLowerCase());
  const [schedules, roster] = await Promise.all([
    Promise.allSettled(lookups.map(({ season, type }) => espnJson(league, `teams/${slug}/schedule?season=${season}&seasontype=${type}`))),
    espnJson(league, `teams/${slug}/roster`).catch(() => null),
  ]);
  if (schedules.every((r) => r.status === 'rejected')) throw schedules[0].reason;

  const seen = new Set();
  const games = schedules
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => niche.gamesFromSchedule(r.value, team))
    .filter((g) => !seen.has(g.id) && seen.add(g.id))
    .sort((x, y) => x.date.localeCompare(y.date));

  // closing lines for the most recent games
  const cache = lineCache(league);
  const recent = games.slice(-ATS_WINDOW[league]);
  const missing = recent.filter((g) => !(g.id in cache.map));
  if (missing.length) {
    await pool(missing, 6, async (g) => {
      try {
        cache.map[g.id] = niche.parseGameLine(await espnJson(league, `summary?event=${encodeURIComponent(g.id)}`));
      } catch {
        /* leave uncached; try again next time */
      }
    });
    cache.save();
  }
  for (const g of recent) g.line = cache.map[g.id] || null;

  const ats = niche.atsSplits(recent, league, team);
  const data = {
    abbr: team,
    headCoach: niche.headCoachFromRoster(roster),
    division: niche.divisionOf(league, team),
    seasons,
    games: games.length,
    splits: niche.situationalSplits(games, league, team),
    ats: ats.ats,
    ou: ats.ou,
    atsStreak: ats.atsStreak,
    ouStreak: ats.ouStreak,
    atsGames: recent.length,
    gamesWithLine: ats.gamesWithLine,
    recent: games.slice(-5).reverse().map(({ date, home, opp, teamScore, oppScore, result }) => ({ date, home, opp, teamScore, oppScore, result })),
  };
  nicheCache[key] = { at: Date.now(), data };
  return data;
}

// ---------- box scores & auto-settle ----------

// Final box scores never change: keep compact versions on disk.
const boxCaches = {};
function boxCache(league) {
  if (!boxCaches[league]) {
    const file = path.join(path.dirname(DATA_FILE), 'cache', `box-${league}.json`);
    let map = {};
    try {
      map = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    let timer = null;
    boxCaches[league] = {
      map,
      save() {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(map));
          } catch (err) {
            console.warn('Could not save box score cache:', err.message);
          }
        }, 500);
      },
    };
  }
  return boxCaches[league];
}

async function getBoxScore(league, eventId) {
  const cache = boxCache(league);
  if (cache.map[eventId]) return cache.map[eventId];
  const box = grading.parseBoxScore(await espnJson(league, `summary?event=${encodeURIComponent(eventId)}`));
  if (box.completed) {
    cache.map[eventId] = box;
    cache.save();
  }
  return box;
}

const teamScheduleCache = {}; // `${league}:${team}:${season}` -> { at, payloads }
async function getTeamSeasonSchedule(league, team, season) {
  const key = `${league}:${team}:${season}`;
  const c = teamScheduleCache[key];
  if (c && Date.now() - c.at < 15 * 60 * 1000) return c.payloads;
  const slug = encodeURIComponent(team.toLowerCase());
  const res = await Promise.allSettled([2, 3].map((t) => espnJson(league, `teams/${slug}/schedule?season=${season}&seasontype=${t}`)));
  if (res.every((r) => r.status === 'rejected')) throw res[0].reason;
  const payloads = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  teamScheduleCache[key] = { at: Date.now(), payloads };
  return payloads;
}

// Grade every pending straight bet / parlay leg. Nothing is saved: the page asks you first.
async function autoSettle() {
  const today = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const bet of db.bets) {
    const items = bet.legs && bet.legs.length ? bet.legs.map((l) => ({ pick: { ...l, sport: l.sport || bet.sport }, legId: l.id })) : [{ pick: bet, legId: null }];
    for (const { pick, legId } of items) {
      if ((pick.result || 'pending') !== 'pending' || !bet.date || bet.date > today) continue;
      const league = String(pick.sport || '').toLowerCase();
      if (!LEAGUE_PATHS[league]) continue;
      jobs.push({ bet, pick, legId, league });
    }
  }
  const results = await pool(jobs, 4, async ({ bet, pick, legId, league }) => {
    const base = { betId: bet.id, legId };
    const team = pick.team || pick.opponent;
    if (!team) return { ...base, status: 'review', reason: 'No team on this pick, so its game can\'t be found' };
    try {
      const payloads = await getTeamSeasonSchedule(league, team, grading.seasonForDate(league, bet.date));
      const game = grading.findGameForPick(payloads, team, pick.team ? pick.opponent : pick.team, bet.date);
      if (!game) return { ...base, status: 'notFound', reason: 'No game found within 10 days of the bet date' };
      if (!game.final) return { ...base, status: 'pending', reason: 'Game not final yet' };
      const box = await getBoxScore(league, game.id);
      return { ...base, gameId: game.id, gameDate: game.date, ...grading.gradePick(pick, box, league) };
    } catch (err) {
      return { ...base, status: 'error', reason: err.message };
    }
  });
  return { checked: jobs.length, results };
}

// ---------- player prop research ----------

async function propResearch(league, team, player, prop, line, side, opp) {
  if (grading.statForProp(league, prop, {}) === undefined) throw Object.assign(new Error(`"${prop}" isn't a stat the site can look up`), { status: 400 });
  const season = niche.nicheSeasons(league).slice(-1)[0];
  let games = [];
  for (const s of [season, season - 1]) {
    const payloads = await getTeamSeasonSchedule(league, team, s);
    games = games.concat(payloads.flatMap((p) => niche.gamesFromSchedule(p, team)));
    if (games.length >= 14) break;
  }
  const seen = new Set();
  games = games.filter((g) => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 16);
  const rows = (
    await pool(games, 4, async (g) => {
      try {
        const box = await getBoxScore(league, g.id);
        const p = grading.findPlayer(box, player, team);
        if (!p) return { date: g.date, opp: g.opp, home: g.home, value: null, dnp: true };
        const v = grading.statForProp(league, prop, p.stats);
        return { date: g.date, opp: g.opp, home: g.home, value: v == null ? 0 : v, name: p.name };
      } catch {
        return null;
      }
    })
  ).filter(Boolean);
  const name = (rows.find((r) => r.name) || {}).name || null;
  if (!name) throw Object.assign(new Error(`Couldn't find ${player} in ${team}'s recent box scores. Check the spelling and the team.`), { status: 404 });
  // last 10 games the player actually played (keep DNPs in between for context)
  const out = [];
  let played = 0;
  for (const r of rows) {
    if (played >= 10) break;
    out.push(r);
    if (!r.dnp) played++;
  }
  const l = line === '' || line == null ? grading.defaultLine(league, prop) : Number(line);
  const summary = grading.propResearchSummary(out, l, side);
  const vsOpp = opp ? out.filter((r) => r.opp === opp && !r.dnp) : [];
  return { player: name, team, prop, line: l, side: side || 'Over', games: out, summary, vsOpp };
}

// ---------- weather ----------

const weatherCache = {}; // `${home}:${kickoff hour}` -> { at, data }
async function getWeather(home, kickoff, { neutral, indoor } = {}) {
  const stadium = weather.STADIUMS[home];
  if (neutral) return { roof: 'neutral', note: 'Neutral-site game' };
  if (!stadium) return { roof: 'unknown', note: 'Stadium not known' };
  if (stadium.roof === 'dome' || indoor) return { roof: 'dome', stadium: stadium.name };
  const k = Date.parse(kickoff);
  if (!isFinite(k)) throw Object.assign(new Error('Bad kickoff time'), { status: 400 });
  if (k - Date.now() > 15 * 86400000) return { roof: stadium.roof, stadium: stadium.name, status: 'too-far', note: 'Forecast available about 2 weeks out' };
  if (k + 4 * 3600000 < Date.now()) return { roof: stadium.roof, stadium: stadium.name, status: 'past' };
  const key = `${home}:${new Date(k).toISOString().slice(0, 13)}`;
  const c = weatherCache[key];
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.data;
  const r = await fetch(weather.forecastUrl(stadium, kickoff), { headers: { 'User-Agent': 'BetSite/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Weather service responded ${r.status}`);
  const data = { roof: stadium.roof, stadium: stadium.name, ...(weather.summarizeForecast(await r.json(), kickoff) || { status: 'unavailable' }) };
  weatherCache[key] = { at: Date.now(), data };
  return data;
}

// ---------- trends (streaks & suggestions) ----------

const TRENDS_TTL_MS = 3 * 60 * 60 * 1000;
const trendJobs = {}; // `${league}:${days}` -> { status, progress, data, at, error }

function etSlots(iso) {
  return niche.nflSlots(iso);
}

async function buildTrends(league, days, job) {
  const sched = await getSchedule(league, days);
  const upcoming = sched.games.filter((g) => g.state !== 'post');
  const teamGames = new Map(); // team -> { game, opp, home }
  for (const g of upcoming) {
    if (!teamGames.has(g.home.abbr)) teamGames.set(g.home.abbr, { game: g, opp: g.away.abbr, home: true });
    if (!teamGames.has(g.away.abbr)) teamGames.set(g.away.abbr, { game: g, opp: g.home.abbr, home: false });
  }
  const teams = [...teamGames.keys()];
  job.progress = { done: 0, total: teams.length };
  const teamItems = [];
  const logsByTeam = {};

  await pool(teams, 3, async (team) => {
    const ctx = teamGames.get(team);
    const fav = /^([A-Z]{2,4})\s+-/.exec(ctx.game.spread || '');
    try {
      const n = await getTeamNiche(league, team);
      for (const item of trends.teamTrends(n, { opp: ctx.opp, home: ctx.home, slots: league === 'nfl' ? etSlots(ctx.game.date) : {}, favorite: fav ? fav[1] : null })) {
        teamItems.push({ ...item, gameId: ctx.game.id, gameDate: ctx.game.date, matchup: `${ctx.game.away.abbr} @ ${ctx.game.home.abbr}`, spread: ctx.game.spread, overUnder: ctx.game.overUnder });
      }
    } catch (err) {
      console.warn(`Trends: team stats for ${team} failed: ${err.message}`);
    }
    // recent box scores for player streaks
    try {
      const season = niche.nicheSeasons(league).slice(-1)[0];
      let games = [];
      for (const s of [season, season - 1]) {
        const payloads = await getTeamSeasonSchedule(league, team, s);
        games = games.concat(payloads.flatMap((p) => niche.gamesFromSchedule(p, team)));
        if (games.length >= 10) break;
      }
      const seen = new Set();
      games = games.filter((g) => !seen.has(g.id) && seen.add(g.id)).sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
      const boxes = {};
      await pool(games, 3, async (g) => {
        try {
          boxes[g.id] = await getBoxScore(league, g.id);
        } catch {}
      });
      logsByTeam[team] = trends.playerLogs(games, boxes, team);
    } catch (err) {
      console.warn(`Trends: box scores for ${team} failed: ${err.message}`);
    }
    job.progress.done++;
  });

  const withGame = (item) => {
    const ctx = teamGames.get(item.team) || {};
    const g = ctx.game || {};
    return { ...item, opp: ctx.opp, gameId: g.id, gameDate: g.date, matchup: g.id ? `${g.away.abbr} @ ${g.home.abbr}` : '' };
  };
  const players = Object.values(logsByTeam).flatMap((logs) => trends.milestoneStreaks(logs, league)).map(withGame);
  const props = cachedPropsFor(league);
  const propItems = props.length ? trends.propLineStreaks(logsByTeam, props, league).map(withGame) : [];
  return {
    league,
    days,
    builtAt: new Date().toISOString(),
    games: upcoming.length,
    teams: teamItems.sort((a, b) => b.score - a.score),
    players: players.slice(0, 120),
    propLines: propItems.slice(0, 80),
    propsAvailable: props.length,
  };
}

function trendsStatus(league, days, force) {
  const key = `${league}:${days}`;
  const job = trendJobs[key] || (trendJobs[key] = { status: 'idle' });
  const stale = !job.at || Date.now() - job.at > TRENDS_TTL_MS;
  if (job.status !== 'building' && (force || stale)) {
    job.status = 'building';
    job.error = null;
    job.progress = { done: 0, total: 0 };
    buildTrends(league, days, job)
      .then((data) => Object.assign(job, { status: 'ready', data, at: Date.now() }))
      .catch((err) => Object.assign(job, { status: job.data ? 'ready' : 'error', error: err.message }));
  }
  return { status: job.status, progress: job.progress, error: job.error, data: job.data || null };
}

// Prop lines fetched on the Market tab (none until the props feature is used).
function cachedPropsFor(league) {
  return typeof marketProps === 'function' ? marketProps(league) : [];
}

// ---------- phone access ----------

async function handleAuthApi(req, res, url, local) {
  const action = url.pathname.split('/')[3];
  if (action === 'status' && req.method === 'GET') {
    return send(res, 200, { passwordSet: auth.passwordSet(), local, sessions: auth.sessionCount(), urls: local ? lanUrls() : [] });
  }
  if (action === 'logout' && req.method === 'POST') {
    auth.endSession(auth.tokenFrom(req));
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
  }
  if (!local) return send(res, 403, { error: 'Change phone access from the computer running BetSite.' });
  if (action === 'password' && req.method === 'POST') {
    const body = await readBody(req);
    auth.setPassword(body.password);
    return send(res, 200, { ok: true });
  }
  if (action === 'disable' && req.method === 'POST') {
    auth.disable();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
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

  if (resource === 'niche') {
    const league = (id || '').toLowerCase();
    const a = String(url.searchParams.get('a') || '').toUpperCase();
    const b = String(url.searchParams.get('b') || '').toUpperCase();
    if (!LEAGUE_PATHS[league]) return send(res, 404, { error: 'Unknown league' });
    if (!/^[A-Z]{2,4}$/.test(a) || !/^[A-Z]{2,4}$/.test(b) || a === b) return send(res, 400, { error: 'Pass two different team abbreviations as ?a=&b=' });
    const force = url.searchParams.has('refresh');
    const [ra, rb] = await Promise.allSettled([getTeamNiche(league, a, force), getTeamNiche(league, b, force)]);
    if (ra.status === 'rejected' && rb.status === 'rejected') return send(res, 502, { error: `Could not load niche stats: ${ra.reason.message}` });
    return send(res, 200, {
      league,
      fetchedAt: new Date().toISOString(),
      teams: {
        [a]: ra.status === 'fulfilled' ? ra.value : { abbr: a, error: ra.reason.message },
        [b]: rb.status === 'fulfilled' ? rb.value : { abbr: b, error: rb.reason.message },
      },
    });
  }

  if (resource === 'propresearch') {
    const league = (id || '').toLowerCase();
    if (!LEAGUE_PATHS[league]) return send(res, 404, { error: 'Unknown league' });
    const q = url.searchParams;
    const team = String(q.get('team') || '').toUpperCase();
    if (!/^[A-Z]{2,4}$/.test(team)) return send(res, 400, { error: "Pick the player's team first" });
    if (!q.get('player')) return send(res, 400, { error: 'Enter the player first' });
    if (!q.get('prop')) return send(res, 400, { error: 'Enter the prop category first' });
    try {
      return send(res, 200, await propResearch(league, team, q.get('player'), q.get('prop'), q.get('line'), q.get('side'), String(q.get('opp') || '').toUpperCase()));
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  if (resource === 'weather') {
    const q = url.searchParams;
    try {
      return send(res, 200, await getWeather(String(q.get('home') || '').toUpperCase(), q.get('date'), { neutral: q.get('neutral') === '1', indoor: q.get('indoor') === '1' }));
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  if (resource === 'trends') {
    const league = (id || '').toLowerCase();
    if (!LEAGUE_PATHS[league]) return send(res, 404, { error: 'Unknown league' });
    const days = Math.min(14, Math.max(1, parseInt(url.searchParams.get('days'), 10) || (league === 'nfl' ? 7 : 2)));
    return send(res, 200, trendsStatus(league, days, url.searchParams.has('refresh')));
  }

  if (resource === 'autosettle' && req.method === 'POST') {
    return send(res, 200, await autoSettle());
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
  if (req.method === 'PUT' && idx === -1 && ['teamNotes', 'coaches', 'settings'].includes(resource)) {
    // team notes and coaching staffs are keyed by "SPORT-ABBR" and created on first save
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

// Addresses other devices can use to reach this computer.
function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) || /tailscale|utun/i.test(name);
      out.push({ url: `http://${a.address}:${PORT}`, kind: tailscale ? 'tailscale' : 'wifi' });
    }
  }
  const host = os.hostname();
  if (host) out.push({ url: `http://${host.endsWith('.local') ? host : host + '.local'}:${PORT}`, kind: 'name' });
  return out;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10000) return req.destroy();
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Requests from other devices: blocked until a password is set, then sign-in required.
// Returns true when the request has been answered here.
async function remoteGate(req, res, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (!auth.passwordSet()) {
    if (isApi) send(res, 403, { error: 'Phone access is off. Set a password in Settings on the computer running BetSite.' });
    else send(res, 403, blockedPage(), { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const pw = new URLSearchParams(await readRaw(req)).get('password') || '';
      if (!auth.allowAttempt(ip)) {
        send(res, 429, loginPage('Too many tries. Wait 15 minutes and try again.'), { 'Content-Type': 'text/html; charset=utf-8' });
      } else if (auth.verify(pw)) {
        res.writeHead(302, { Location: '/', 'Set-Cookie': auth.cookieHeader(auth.createSession(req.headers['user-agent'])) });
        res.end();
      } else {
        send(res, 401, loginPage('Wrong password.'), { 'Content-Type': 'text/html; charset=utf-8' });
      }
    } else {
      send(res, 200, loginPage(), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return true;
  }
  if (auth.validSession(auth.tokenFrom(req))) return false;
  if (isApi) send(res, 401, { error: 'Sign in required' });
  else {
    res.writeHead(302, { Location: '/login' });
    res.end();
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const local = isLocalRequest(req);
    if (!local && (await remoteGate(req, res, url))) return;
    if (url.pathname === '/login') {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/auth/')) return await handleAuthApi(req, res, url, local);
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
    if (auth.passwordSet()) {
      const wifi = lanUrls().find((u) => u.kind === 'wifi');
      if (wifi) console.log(`On your phone (same Wi-Fi): ${wifi.url}`);
    }
  });
}

module.exports = { server };
