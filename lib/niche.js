'use strict';

// "Niche stats" for a team, computed from ESPN data:
// - situational records (MNF / TNF / SNF / primetime, home/away, division, after a loss, ...)
//   from team schedules (kickoff times converted to US Eastern)
// - against-the-spread and over/under records from each game's closing line (game summaries)
// All functions here are pure so they can be unit-tested with fixtures.

const DIVISIONS = {
  nfl: {
    'AFC East': ['BUF', 'MIA', 'NE', 'NYJ'], 'AFC North': ['BAL', 'CIN', 'CLE', 'PIT'],
    'AFC South': ['HOU', 'IND', 'JAX', 'TEN'], 'AFC West': ['DEN', 'KC', 'LV', 'LAC'],
    'NFC East': ['DAL', 'NYG', 'PHI', 'WSH'], 'NFC North': ['CHI', 'DET', 'GB', 'MIN'],
    'NFC South': ['ATL', 'CAR', 'NO', 'TB'], 'NFC West': ['ARI', 'LAR', 'SF', 'SEA'],
  },
  nba: {
    Atlantic: ['BOS', 'BKN', 'NY', 'PHI', 'TOR'], Central: ['CHI', 'CLE', 'DET', 'IND', 'MIL'],
    Southeast: ['ATL', 'CHA', 'MIA', 'ORL', 'WSH'], Northwest: ['DEN', 'MIN', 'OKC', 'POR', 'UTAH'],
    Pacific: ['GS', 'LAC', 'LAL', 'PHX', 'SAC'], Southwest: ['DAL', 'HOU', 'MEM', 'NO', 'SA'],
  },
};

function divisionOf(league, abbr) {
  const d = DIVISIONS[league] || {};
  return Object.keys(d).find((k) => d[k].includes(abbr)) || null;
}

function num(v) {
  if (v && typeof v === 'object') v = v.value != null ? v.value : v.displayValue;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });

// Weekday, hour and calendar date of a kickoff in US Eastern time.
function etInfo(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const parts = Object.fromEntries(ET.formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), dateKey: `${parts.year}-${parts.month}-${parts.day}` };
}

// NFL primetime = kickoff 7 PM ET or later. MNF = any Monday game; TNF / SNF = Thursday / Sunday night.
function nflSlots(iso) {
  const t = etInfo(iso);
  if (!t) return {};
  const night = t.hour >= 19;
  return { primetime: night, mnf: t.weekday === 'Mon', tnf: t.weekday === 'Thu' && night, snf: t.weekday === 'Sun' && night };
}

// Completed games for `team` from one ESPN team-schedule payload.
function gamesFromSchedule(json, team) {
  const out = [];
  for (const e of Array.isArray(json && json.events) ? json.events : []) {
    const comp = (Array.isArray(e.competitions) && e.competitions[0]) || {};
    const type = (comp.status && comp.status.type) || (e.status && e.status.type) || {};
    if (!(type.completed || type.state === 'post')) continue;
    const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
    const me = cs.find((c) => c && c.team && String(c.team.abbreviation).toUpperCase() === team);
    const opp = cs.find((c) => c && c !== me);
    if (!me || !opp) continue;
    const ts = num(me.score);
    const os = num(opp.score);
    if (ts == null || os == null) continue;
    const national = (Array.isArray(comp.broadcasts) ? comp.broadcasts : []).some(
      (b) => b && ((b.market && /national/i.test(b.market.type || b.market)) || /national/i.test(b.market || ''))
    );
    out.push({
      id: String(e.id),
      date: String(e.date || comp.date || ''),
      home: me.homeAway === 'home',
      opp: String(opp.team.abbreviation).toUpperCase(),
      teamScore: ts,
      oppScore: os,
      result: ts > os ? 'W' : ts < os ? 'L' : 'T',
      postseason: !!(e.seasonType && Number(e.seasonType.type) === 3),
      nationalTv: national,
    });
  }
  return out;
}

function record(games) {
  const r = { w: 0, l: 0, t: 0, n: games.length };
  for (const g of games) {
    if (g.result === 'W') r.w++;
    else if (g.result === 'L') r.l++;
    else r.t++;
  }
  return r;
}

// Situational win-loss splits. `games` must be sorted oldest -> newest.
function situationalSplits(games, league, team) {
  const div = divisionOf(league, team);
  const splits = [];
  const add = (key, label, list) => splits.push({ key, label, ...record(list) });
  add('overall', 'Overall', games);
  add('home', 'Home', games.filter((g) => g.home));
  add('away', 'Away', games.filter((g) => !g.home));
  if (league === 'nfl') {
    const slot = (g) => nflSlots(g.date);
    add('primetime', 'Primetime (7 PM ET+)', games.filter((g) => slot(g).primetime));
    add('mnf', 'Monday Night', games.filter((g) => slot(g).mnf));
    add('tnf', 'Thursday Night', games.filter((g) => slot(g).tnf));
    add('snf', 'Sunday Night', games.filter((g) => slot(g).snf));
  } else {
    add('national', 'National TV', games.filter((g) => g.nationalTv));
    const b2b = games.filter((g, i) => {
      if (!i) return false;
      const prev = etInfo(games[i - 1].date);
      const cur = etInfo(g.date);
      return prev && cur && (Date.parse(cur.dateKey) - Date.parse(prev.dateKey)) / 86400000 === 1;
    });
    add('b2b', '2nd night of back-to-back', b2b);
  }
  if (div) add('division', 'Division games', games.filter((g) => divisionOf(league, g.opp) === div));
  add('afterLoss', 'After a loss', games.filter((g, i) => i > 0 && games[i - 1].result === 'L'));
  add('afterWin', 'After a win', games.filter((g, i) => i > 0 && games[i - 1].result === 'W'));
  add('playoffs', 'Playoffs', games.filter((g) => g.postseason));
  add('last10', 'Last 10 games', games.slice(-10));
  return splits.filter((s) => s.n > 0 || ['overall', 'mnf', 'primetime', 'snf', 'tnf'].includes(s.key));
}

// Closing line from a game summary: { favorite, spread (favorite's, <= 0), overUnder }.
function parseGameLine(json) {
  const pcs = [].concat((json && json.pickcenter) || [], (json && json.odds) || []).filter(Boolean);
  const pc = pcs.find((p) => p.details || p.spread != null || p.overUnder != null);
  if (!pc) return null;
  const ou = num(pc.overUnder);
  let favorite = null;
  let spread = null;
  const details = String(pc.details || '').trim();
  const m = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/i.exec(details);
  if (m) {
    favorite = m[1].toUpperCase();
    spread = -Math.abs(Number(m[2]));
  } else if (/^(EVEN|PK|PICK)/i.test(details)) {
    spread = 0;
  } else if (num(pc.spread) != null) {
    const comp = (json.header && Array.isArray(json.header.competitions) && json.header.competitions[0]) || {};
    const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
    const homeFav = pc.homeTeamOdds && pc.homeTeamOdds.favorite;
    const awayFav = pc.awayTeamOdds && pc.awayTeamOdds.favorite;
    const side = homeFav ? 'home' : awayFav ? 'away' : null;
    const c = side && cs.find((x) => x.homeAway === side);
    if (c && c.team) favorite = String(c.team.abbreviation).toUpperCase();
    spread = -Math.abs(num(pc.spread));
  }
  if (spread == null && ou == null) return null;
  return { favorite, spread, overUnder: ou };
}

// Against-the-spread and over/under records. Each game needs `line` from parseGameLine.
function atsSplits(games, league, team) {
  const withLine = games.filter((g) => g.line && g.line.spread != null);
  const atsResult = (g) => {
    const mine = g.line.spread === 0 ? 0 : g.line.favorite === team ? g.line.spread : -g.line.spread;
    const diff = g.teamScore + mine - g.oppScore;
    return diff > 0 ? 'W' : diff < 0 ? 'L' : 'P';
  };
  const rec = (list) => {
    const r = { w: 0, l: 0, p: 0, n: list.length };
    for (const g of list) {
      const x = atsResult(g);
      if (x === 'W') r.w++;
      else if (x === 'L') r.l++;
      else r.p++;
    }
    return r;
  };
  const isFav = (g) => g.line.spread < 0 && g.line.favorite === team;
  const isDog = (g) => g.line.spread < 0 && g.line.favorite && g.line.favorite !== team;
  const ats = [
    { key: 'overall', label: 'Overall', ...rec(withLine) },
    { key: 'fav', label: 'As favorite', ...rec(withLine.filter(isFav)) },
    { key: 'dog', label: 'As underdog', ...rec(withLine.filter(isDog)) },
    { key: 'home', label: 'Home', ...rec(withLine.filter((g) => g.home)) },
    { key: 'away', label: 'Away', ...rec(withLine.filter((g) => !g.home)) },
  ];
  if (league === 'nfl') {
    ats.push({ key: 'primetime', label: 'Primetime', ...rec(withLine.filter((g) => nflSlots(g.date).primetime)) });
    for (const [key, label] of [['mnf', 'Monday Night'], ['tnf', 'Thursday Night'], ['snf', 'Sunday Night']]) {
      const r = rec(withLine.filter((g) => nflSlots(g.date)[key]));
      if (r.n) ats.push({ key, label, ...r });
    }
  }
  ats.push({ key: 'last10', label: 'Last 10 with a line', ...rec(withLine.slice(-10)) });

  // current streaks, newest game backwards (pushes are skipped, not streak-breaking)
  const streakOf = (results) => {
    const r = results.filter((x) => x !== 'P');
    if (!r.length) return null;
    let n = 0;
    for (let i = r.length - 1; i >= 0 && r[i] === r[r.length - 1]; i--) n++;
    return { type: r[r.length - 1], length: n };
  };
  const atsStreak = streakOf(withLine.map(atsResult));
  const ouStreak = streakOf(
    games.filter((g) => g.line && g.line.overUnder != null).map((g) => {
      const t = g.teamScore + g.oppScore;
      return t > g.line.overUnder ? 'O' : t < g.line.overUnder ? 'U' : 'P';
    })
  );

  const ou = { over: 0, under: 0, push: 0, n: 0, avgTotal: null };
  let total = 0;
  for (const g of games) {
    if (!g.line || g.line.overUnder == null) continue;
    const t = g.teamScore + g.oppScore;
    total += t;
    ou.n++;
    if (t > g.line.overUnder) ou.over++;
    else if (t < g.line.overUnder) ou.under++;
    else ou.push++;
  }
  ou.avgTotal = ou.n ? Math.round((total / ou.n) * 10) / 10 : null;
  return { ats, ou, gamesWithLine: withLine.length, atsStreak, ouStreak };
}

// Seasons to cover: NFL current + 3 previous; NBA current + previous (seasons named by end year).
function nicheSeasons(league, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  if (league === 'nba') {
    const cur = m >= 8 ? y + 1 : y;
    return [cur - 1, cur];
  }
  const cur = m >= 3 ? y : y - 1;
  return [cur - 3, cur - 2, cur - 1, cur];
}

// Head coach from ESPN's roster payload (…/teams/{abbr}/roster), if listed.
function headCoachFromRoster(json) {
  const c = json && Array.isArray(json.coach) && json.coach[0];
  if (!c) return null;
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name ? { name, experience: c.experience != null ? Number(c.experience) : null } : null;
}

module.exports = { DIVISIONS, divisionOf, etInfo, nflSlots, gamesFromSchedule, situationalSplits, parseGameLine, atsSplits, nicheSeasons, headCoachFromRoster };
