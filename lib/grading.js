'use strict';

// Grading bets from ESPN results:
// - parseBoxScore: compact per-player stat lines + final scores from a game summary
// - statForProp: the stat a player prop is graded on (e.g. "Rush + Rec Yards")
// - gradePick: won / lost / push for moneyline, spread, total, team total and player props
// - findGameForPick: which completed game in a team schedule a bet belongs to
// Pure functions, unit-tested with fixtures.

const { etInfo, gamesFromSchedule } = require('./niche');

function num(v) {
  if (v && typeof v === 'object') v = v.value != null ? v.value : v.displayValue;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// { completed, teams: { ABBR: score }, players: { normName: { name, team, stats: { 'passing.YDS': 312, ... } } } }
function parseBoxScore(json) {
  const comp = (json && json.header && Array.isArray(json.header.competitions) && json.header.competitions[0]) || {};
  const type = (comp.status && comp.status.type) || {};
  const teams = {};
  for (const c of Array.isArray(comp.competitors) ? comp.competitors : []) {
    if (c && c.team) teams[String(c.team.abbreviation).toUpperCase()] = num(c.score);
  }
  const players = {};
  for (const tp of (json && json.boxscore && Array.isArray(json.boxscore.players) && json.boxscore.players) || []) {
    const team = String((tp.team && tp.team.abbreviation) || '').toUpperCase();
    for (const cat of Array.isArray(tp.statistics) ? tp.statistics : []) {
      const prefix = cat.name || 'stats';
      const labels = Array.isArray(cat.labels) ? cat.labels : [];
      for (const a of Array.isArray(cat.athletes) ? cat.athletes : []) {
        if (!a || !a.athlete || !Array.isArray(a.stats) || !a.stats.length) continue;
        const name = a.athlete.displayName || a.athlete.fullName;
        const key = normName(name);
        if (!key) continue;
        const p = (players[key] = players[key] || { name, team, stats: {} });
        labels.forEach((label, i) => {
          const raw = a.stats[i];
          if (raw == null || raw === '') return;
          // split stats like "C/ATT" = "25/34" or NBA "FG" = "9-18"
          const parts = String(raw).split(/[/-]/);
          const labelParts = String(label).split('/');
          if (labelParts.length === 2 && parts.length === 2) {
            p.stats[`${prefix}.${labelParts[0]}`] = num(parts[0]);
            p.stats[`${prefix}.${labelParts[1]}`] = num(parts[1]);
          } else if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && !String(raw).startsWith('-')) {
            p.stats[`${prefix}.${label}`] = num(parts[0]); // made
            p.stats[`${prefix}.${label}_A`] = num(parts[1]); // attempted
          } else {
            p.stats[`${prefix}.${label}`] = num(raw);
          }
        });
      }
    }
  }
  return { completed: !!(type.completed || type.state === 'post'), teams, players };
}

// Prop category -> how to compute it from a stat line. NBA box scores use one unnamed category ("stats").
const sum = (...keys) => (s) => {
  const vals = keys.map((k) => s[k]);
  return vals.every((v) => v == null) ? null : vals.reduce((t, v) => t + (v || 0), 0);
};
const one = (k) => (s) => (s[k] == null ? null : s[k]);
const countTens = (n) => (s) => {
  const vals = ['stats.PTS', 'stats.REB', 'stats.AST', 'stats.STL', 'stats.BLK'].map((k) => s[k]);
  if (vals.every((v) => v == null)) return null;
  return vals.filter((v) => v >= 10).length >= n ? 1 : 0;
};
const PROPS = {
  nfl: {
    passingyards: one('passing.YDS'), passingtds: one('passing.TD'), passcompletions: one('passing.C'), passattempts: one('passing.ATT'),
    interceptionsthrown: one('passing.INT'), rushingyards: one('rushing.YDS'), rushingattempts: one('rushing.CAR'),
    receivingyards: one('receiving.YDS'), receptions: one('receiving.REC'), longestreception: one('receiving.LONG'),
    rushrecyards: sum('rushing.YDS', 'receiving.YDS'), anytimetd: sum('rushing.TD', 'receiving.TD'), '2tds': sum('rushing.TD', 'receiving.TD'),
    sacks: one('defensive.SACKS'), tacklesassists: one('defensive.TOT'), kickingpoints: one('kicking.PTS'), fieldgoalsmade: one('kicking.FG'),
  },
  nba: {
    points: one('stats.PTS'), rebounds: one('stats.REB'), assists: one('stats.AST'),
    ptsrebast: sum('stats.PTS', 'stats.REB', 'stats.AST'), ptsreb: sum('stats.PTS', 'stats.REB'), ptsast: sum('stats.PTS', 'stats.AST'),
    rebast: sum('stats.REB', 'stats.AST'), '3pointersmade': one('stats.3PT'), steals: one('stats.STL'), blocks: one('stats.BLK'),
    stealsblocks: sum('stats.STL', 'stats.BLK'), turnovers: one('stats.TO'), doubledouble: countTens(2), tripledouble: countTens(3),
  },
};
const ALIASES = {
  passyards: 'passingyards', passyds: 'passingyards', passingyds: 'passingyards', passtds: 'passingtds', passingtouchdowns: 'passingtds',
  completions: 'passcompletions', attempts: 'passattempts', interceptions: 'interceptionsthrown', ints: 'interceptionsthrown',
  rushyards: 'rushingyards', rushyds: 'rushingyards', rushingyds: 'rushingyards', carries: 'rushingattempts', rushattempts: 'rushingattempts',
  recyards: 'receivingyards', recyds: 'receivingyards', receivingyds: 'receivingyards', catches: 'receptions', rec: 'receptions',
  rushreceivingyards: 'rushrecyards', rushandrecyards: 'rushrecyards', scrimmageyards: 'rushrecyards', longestrec: 'longestreception',
  anytimetouchdown: 'anytimetd', anytimetouchdownscorer: 'anytimetd', touchdown: 'anytimetd', '2touchdowns': '2tds',
  tackles: 'tacklesassists', fgmade: 'fieldgoalsmade', fieldgoals: 'fieldgoalsmade',
  pts: 'points', reb: 'rebounds', ast: 'assists', pra: 'ptsrebast', pointsreboundsassists: 'ptsrebast', ptsrebsast: 'ptsrebast',
  pr: 'ptsreb', pointsrebounds: 'ptsreb', pa: 'ptsast', pointsassists: 'ptsast', ra: 'rebast', reboundsassists: 'rebast',
  threes: '3pointersmade', '3pm': '3pointersmade', threepointersmade: '3pointersmade', '3ptmade': '3pointersmade',
  stl: 'steals', blk: 'blocks', stocks: 'stealsblocks', to: 'turnovers', dd: 'doubledouble', td: 'tripledouble',
};
const catKey = (c) => {
  const k = String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ALIASES[k] || k;
};

function statForProp(league, category, stats) {
  const fn = (PROPS[league] || {})[catKey(category)];
  return fn ? fn(stats || {}) : undefined; // undefined = category we can't grade
}

// Default line for yes/no props without one (e.g. "Anytime TD: Yes" means 1+).
function defaultLine(league, category) {
  const k = catKey(category);
  if (k === '2tds') return 1.5;
  if (['anytimetd', 'doubledouble', 'tripledouble'].includes(k)) return 0.5;
  return null;
}

function findPlayer(box, name, team) {
  const key = normName(name);
  if (box.players[key]) return box.players[key];
  // fall back to last name (+ team) when it's unique, e.g. "Mahomes" or "P. Mahomes"
  const last = key.split(' ').pop();
  const matches = Object.values(box.players).filter((p) => normName(p.name).split(' ').pop() === last && (!team || p.team === team));
  return matches.length === 1 ? matches[0] : null;
}

function overUnder(value, line, side) {
  if (side === 'Under' || side === 'No') return value < line ? 'won' : value > line ? 'lost' : 'push';
  return value > line ? 'won' : value < line ? 'lost' : 'push';
}

// Grade one pick (a straight bet or a parlay leg) against a parsed box score.
// Returns { status: 'graded', result, detail } or { status: 'review' | 'unsupported', reason }.
function gradePick(pick, box, league) {
  if (!box || !box.completed) return { status: 'pending', reason: 'Game not final yet' };
  const team = pick.team;
  const opp = pick.opponent || Object.keys(box.teams).find((t) => t !== team);
  const ts = box.teams[team];
  const os = box.teams[opp];
  const score = Object.entries(box.teams).map(([t, s]) => `${t} ${s}`).join(', ');
  const line = pick.line === '' || pick.line == null ? null : Number(pick.line);

  switch (pick.betType) {
    case 'Moneyline':
      if (ts == null || os == null) return { status: 'review', reason: 'Could not find the team in this game' };
      return { status: 'graded', result: ts > os ? 'won' : ts < os ? 'lost' : 'push', detail: score };
    case 'Spread':
      if (ts == null || os == null) return { status: 'review', reason: 'Could not find the team in this game' };
      if (line == null) return { status: 'review', reason: 'No spread entered on this bet' };
      return { status: 'graded', result: overUnder(ts + line - os, 0, 'Over'), detail: `${score} (${team} ${line > 0 ? '+' : ''}${line})` };
    case 'Total': {
      if (line == null || !pick.side) return { status: 'review', reason: 'Total needs a line and Over/Under' };
      const total = Object.values(box.teams).reduce((t, s) => t + (s || 0), 0);
      return { status: 'graded', result: overUnder(total, line, pick.side), detail: `${score} = ${total} total` };
    }
    case 'Game Prop':
      if (catKey(pick.propCategory) === 'teamtotal' && ts != null && line != null && pick.side) {
        return { status: 'graded', result: overUnder(ts, line, pick.side), detail: `${team} scored ${ts}` };
      }
      return { status: 'unsupported', reason: 'Game props other than team totals need to be settled by hand' };
    case 'Player Prop': {
      if (!pick.player) return { status: 'review', reason: 'No player entered on this bet' };
      if (statForProp(league, pick.propCategory, {}) === undefined) return { status: 'unsupported', reason: `"${pick.propCategory || 'This prop'}" can't be graded automatically` };
      const p = findPlayer(box, pick.player, team);
      if (!p) return { status: 'review', reason: `${pick.player} isn't in the box score. They may not have played, and many books void the bet` };
      const value = statForProp(league, pick.propCategory, p.stats);
      if (value == null) return { status: 'graded', result: overUnder(0, line ?? defaultLine(league, pick.propCategory) ?? 0.5, pick.side || 'Over'), detail: `${p.name}: 0 ${pick.propCategory}` };
      const l = line ?? defaultLine(league, pick.propCategory);
      if (l == null || !pick.side) return { status: 'review', reason: `${p.name} had ${value} ${pick.propCategory}; add the line and side to grade it` };
      return { status: 'graded', result: overUnder(value, l, pick.side), detail: `${p.name}: ${value} ${pick.propCategory} (line ${l})` };
    }
    default:
      return { status: 'unsupported', reason: `${pick.betType || 'This bet type'} needs to be settled by hand` };
  }
}

// Season a date belongs to (NFL: start year; NBA: end year).
function seasonForDate(league, ymd) {
  const [y, m] = String(ymd).split('-').map(Number);
  if (league === 'nba') return m >= 8 ? y + 1 : y;
  return m >= 3 ? y : y - 1;
}

// The game a pick refers to: the first game of `team` (vs `opponent`, if given) on or after
// the day before the bet date, within 10 days. Returns { game, final } or null.
// `events` are raw schedule payloads; includes unfinished games so we can tell "not played yet".
function findGameForPick(payloads, team, opponent, betDate) {
  const all = [];
  for (const json of payloads) {
    for (const e of Array.isArray(json && json.events) ? json.events : []) {
      const comp = (Array.isArray(e.competitions) && e.competitions[0]) || {};
      const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
      const me = cs.find((c) => c && c.team && String(c.team.abbreviation).toUpperCase() === team);
      const opp = cs.find((c) => c && c !== me);
      if (!me || !opp) continue;
      const type = (comp.status && comp.status.type) || (e.status && e.status.type) || {};
      all.push({ id: String(e.id), date: String(e.date || comp.date || ''), opp: String(opp.team.abbreviation).toUpperCase(), final: !!(type.completed || type.state === 'post') });
    }
  }
  const start = Date.parse(betDate + 'T00:00:00Z') - 86400000;
  const end = start + 11 * 86400000;
  const candidates = all
    .filter((g) => !opponent || g.opp === opponent)
    .filter((g) => {
      const et = etInfo(g.date);
      const t = et ? Date.parse(et.dateKey + 'T00:00:00Z') : NaN;
      return t >= start && t <= end;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return candidates[0] || null;
}

module.exports = { normName, parseBoxScore, statForProp, gradePick, findGameForPick, seasonForDate, findPlayer, catKey, gamesFromSchedule };
