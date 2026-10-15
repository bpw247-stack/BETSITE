'use strict';

// NFL rankings for the Rankings tab: division standings, offense/defense team rankings and
// "outlier" games (one result far from a team's others that drags its season average).
// Pure functions; the server feeds them ESPN schedules and game summaries.

const DIVISIONS = [
  ['AFC East', ['BUF', 'MIA', 'NE', 'NYJ']],
  ['AFC North', ['BAL', 'CIN', 'CLE', 'PIT']],
  ['AFC South', ['HOU', 'IND', 'JAX', 'TEN']],
  ['AFC West', ['DEN', 'KC', 'LV', 'LAC']],
  ['NFC East', ['DAL', 'NYG', 'PHI', 'WSH']],
  ['NFC North', ['CHI', 'DET', 'GB', 'MIN']],
  ['NFC South', ['ATL', 'CAR', 'NO', 'TB']],
  ['NFC West', ['ARI', 'LAR', 'SF', 'SEA']],
];
const TEAMS = DIVISIONS.flatMap(([, t]) => t);
const DIVISION_OF = Object.fromEntries(DIVISIONS.flatMap(([d, t]) => t.map((a) => [a, d])));
const conferenceOf = (abbr) => (DIVISION_OF[abbr] || '').slice(0, 3);

const str = (v) => (v == null ? '' : String(v));
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}
// "22/31", "22-31", "2-14" -> [22, 31]
function pair(v) {
  const m = /^\s*(-?\d+)\s*[/-]\s*(-?\d+)\s*$/.exec(str(v));
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

function boxStat(boxTeam, names) {
  const stats = (boxTeam && Array.isArray(boxTeam.statistics) && boxTeam.statistics) || [];
  for (const n of names) {
    const s = stats.find((x) => x && (x.name === n || x.label === n || x.abbreviation === n));
    if (s) return s.displayValue != null ? s.displayValue : s.value;
  }
  return null;
}

// Sum one column (e.g. passing "TD") over a team's players in the box score.
function playerTotal(json, abbr, category, label) {
  let total = null;
  for (const tp of (json.boxscore && Array.isArray(json.boxscore.players) && json.boxscore.players) || []) {
    if (str(tp.team && tp.team.abbreviation).toUpperCase() !== abbr) continue;
    for (const cat of Array.isArray(tp.statistics) ? tp.statistics : []) {
      if (cat.name !== category) continue;
      const i = (cat.labels || []).indexOf(label);
      if (i < 0) continue;
      for (const a of Array.isArray(cat.athletes) ? cat.athletes : []) {
        const v = num(a && a.stats && a.stats[i]);
        if (v != null) total = (total || 0) + v;
      }
    }
  }
  return total;
}

// Bump when parseTeamGame reads new fields, so games cached on disk are read again.
const PARSE_VERSION = 2;

// "31:20" -> 1880 seconds
function clock(v) {
  const m = /^\s*(\d+):(\d{2})\s*$/.exec(str(v));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Rushing by the team's quarterback(s): anyone who threw 5+ passes in the game.
function qbRushing(json, abbr) {
  const qbs = new Set();
  let yards = null;
  let att = null;
  for (const tp of (json.boxscore && Array.isArray(json.boxscore.players) && json.boxscore.players) || []) {
    if (str(tp.team && tp.team.abbreviation).toUpperCase() !== abbr) continue;
    for (const cat of Array.isArray(tp.statistics) ? tp.statistics : []) {
      if (cat.name !== 'passing') continue;
      const i = (cat.labels || []).indexOf('C/ATT');
      for (const a of Array.isArray(cat.athletes) ? cat.athletes : []) {
        const [, attempts] = pair(a && a.stats && a.stats[i]);
        if (attempts >= 5 && a.athlete) qbs.add(a.athlete.displayName || a.athlete.fullName);
      }
    }
    for (const cat of Array.isArray(tp.statistics) ? tp.statistics : []) {
      if (cat.name !== 'rushing') continue;
      const yi = (cat.labels || []).indexOf('YDS');
      const ci = (cat.labels || []).indexOf('CAR');
      for (const a of Array.isArray(cat.athletes) ? cat.athletes : []) {
        if (!a || !a.athlete || !qbs.has(a.athlete.displayName || a.athlete.fullName)) continue;
        yards = (yards || 0) + (num(a.stats[yi]) || 0);
        att = (att || 0) + (num(a.stats[ci]) || 0);
      }
    }
  }
  if (qbs.size && yards == null) [yards, att] = [0, 0]; // QB played but didn't run
  return { qbRushYards: yards, qbRushAtt: att };
}

// One finished game's team stats: { id, date, teams: [{ abbr, home, points, stats }, …] } or null.
function parseTeamGame(json) {
  const comp = (json && json.header && Array.isArray(json.header.competitions) && json.header.competitions[0]) || {};
  const type = (comp.status && comp.status.type) || {};
  if (!(type.completed || type.state === 'post')) return null;
  const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
  const box = (json.boxscore && Array.isArray(json.boxscore.teams) && json.boxscore.teams) || [];
  const teams = cs.map((c) => {
    const abbr = str(c.team && c.team.abbreviation).toUpperCase();
    const bt = box.find((t) => t && t.team && str(t.team.abbreviation).toUpperCase() === abbr);
    const [comp_, att] = pair(boxStat(bt, ['completionAttempts', 'Comp/Att', 'Comp-Att']));
    let [sacks, sackYds] = pair(boxStat(bt, ['sacksYardsLost', 'Sacks-Yards Lost', 'Sacks-Yards']));
    if (sacks == null) [sacks, sackYds] = [playerTotal(json, abbr, 'passing', 'SACKS'), null];
    const [thirdMade, thirdAtt] = pair(boxStat(bt, ['thirdDownEff', '3rd down efficiency']));
    return {
      abbr,
      home: c.homeAway === 'home',
      points: num(c.score),
      stats: {
        yards: num(boxStat(bt, ['totalYards', 'Total Yards'])),
        passYards: num(boxStat(bt, ['netPassingYards', 'Passing'])),
        rushYards: num(boxStat(bt, ['rushingYards', 'Rushing'])),
        rushAtt: num(boxStat(bt, ['rushingAttempts', 'Rushing Attempts'])),
        completions: comp_,
        passAtt: att,
        intThrown: num(boxStat(bt, ['interceptions', 'Interceptions thrown'])),
        fumblesLost: num(boxStat(bt, ['fumblesLost', 'Fumbles lost'])),
        turnovers: num(boxStat(bt, ['turnovers', 'Turnovers'])),
        sacksTaken: sacks,
        sackYards: sackYds,
        thirdMade,
        thirdAtt,
        passTd: playerTotal(json, abbr, 'passing', 'TD'),
        rushTd: playerTotal(json, abbr, 'rushing', 'TD'),
        ...qbRushing(json, abbr),
        possessionSec: clock(boxStat(bt, ['possessionTime', 'Possession'])),
      },
    };
  });
  if (teams.length !== 2 || teams.some((t) => !t.abbr || t.points == null)) return null;
  for (const t of teams) {
    const s = t.stats;
    if (s.turnovers == null && (s.intThrown != null || s.fumblesLost != null)) s.turnovers = (s.intThrown || 0) + (s.fumblesLost || 0);
  }
  return { v: PARSE_VERSION, id: str(json.header && json.header.id), date: str(comp.date), teams };
}

// ---------- season totals ----------

const SUM_KEYS = ['yards', 'passYards', 'rushYards', 'rushAtt', 'completions', 'passAtt', 'intThrown', 'fumblesLost', 'turnovers', 'sacksTaken', 'thirdMade', 'thirdAtt', 'passTd', 'rushTd', 'qbRushYards', 'qbRushAtt', 'possessionSec'];

function emptySide() {
  const o = { points: 0 };
  for (const k of SUM_KEYS) o[k] = 0;
  return o;
}

// games: parsed games (regular season). Returns { [abbr]: { games, off, def, log } }.
function aggregate(games) {
  const teams = {};
  const sorted = games.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const g of sorted) {
    g.teams.forEach((t, i) => {
      const o = g.teams[1 - i];
      const rec = (teams[t.abbr] = teams[t.abbr] || { abbr: t.abbr, games: 0, off: emptySide(), def: emptySide(), log: [] });
      rec.games++;
      rec.off.points += t.points;
      rec.def.points += o.points;
      for (const k of SUM_KEYS) {
        rec.off[k] += t.stats[k] || 0;
        rec.def[k] += o.stats[k] || 0;
      }
      rec.log.push({
        id: g.id, date: g.date, opp: o.abbr, home: t.home,
        pf: t.points, pa: o.points, yards: t.stats.yards, yardsAllowed: o.stats.yards,
        rushAllowed: o.stats.rushYards, passAllowed: o.stats.passYards, qbRushAllowed: o.stats.qbRushYards,
      });
    });
  }
  return teams;
}

const per = (v, g) => (g ? v / g : null);
const ratio = (a, b) => (b ? a / b : null);

// Every ranking: which side, what it measures, which way is better, and how to show it.
// rank* values are per game (or a rate) so byes don't skew them; counting stats also show the total.
const METRICS = [
  { key: 'off.yards', side: 'off', label: 'Total yards', short: 'Yds/g', better: 'high', value: (t) => per(t.off.yards, t.games), fmt: 'dec1' },
  { key: 'off.points', side: 'off', label: 'Points', short: 'Pts/g', better: 'high', value: (t) => per(t.off.points, t.games), fmt: 'dec1' },
  { key: 'off.pass', side: 'off', label: 'Passing', short: 'Pass yds/g', better: 'high', value: (t) => per(t.off.passYards, t.games), fmt: 'dec1' },
  { key: 'off.rush', side: 'off', label: 'Rushing', short: 'Rush yds/g', better: 'high', value: (t) => per(t.off.rushYards, t.games), fmt: 'dec1' },
  { key: 'off.passTd', side: 'off', label: 'Passing TDs', short: 'Pass TD', better: 'high', value: (t) => per(t.off.passTd, t.games), total: (t) => t.off.passTd, fmt: 'count' },
  { key: 'off.rushTd', side: 'off', label: 'Rushing TDs', short: 'Rush TD', better: 'high', value: (t) => per(t.off.rushTd, t.games), total: (t) => t.off.rushTd, fmt: 'count' },
  { key: 'off.turnovers', side: 'off', label: 'Turnovers (fewest)', short: 'Giveaways', better: 'low', value: (t) => per(t.off.turnovers, t.games), total: (t) => t.off.turnovers, fmt: 'count' },
  { key: 'off.ypc', side: 'off', label: 'Yards per carry', short: 'YPC', better: 'high', value: (t) => ratio(t.off.rushYards, t.off.rushAtt), fmt: 'dec1' },
  { key: 'off.sackRate', side: 'off', label: 'Sack rate allowed', short: 'Sack %', better: 'low', value: (t) => ratio(t.off.sacksTaken, t.off.passAtt + t.off.sacksTaken), fmt: 'pct', total: (t) => t.off.sacksTaken },
  { key: 'off.third', side: 'off', label: '3rd-down %', short: '3rd %', better: 'high', value: (t) => ratio(t.off.thirdMade, t.off.thirdAtt), fmt: 'pct' },
  { key: 'def.yards', side: 'def', label: 'Total yards allowed', short: 'Yds/g', better: 'low', value: (t) => per(t.def.yards, t.games), fmt: 'dec1' },
  { key: 'def.points', side: 'def', label: 'Points allowed', short: 'Pts/g', better: 'low', value: (t) => per(t.def.points, t.games), fmt: 'dec1' },
  { key: 'def.pass', side: 'def', label: 'Pass defense', short: 'Pass yds/g', better: 'low', value: (t) => per(t.def.passYards, t.games), fmt: 'dec1' },
  { key: 'def.rush', side: 'def', label: 'Run defense', short: 'Rush yds/g', better: 'low', value: (t) => per(t.def.rushYards, t.games), fmt: 'dec1' },
  { key: 'def.ypc', side: 'def', label: 'Yards per carry allowed', short: 'YPC', better: 'low', value: (t) => ratio(t.def.rushYards, t.def.rushAtt), fmt: 'dec1' },
  { key: 'def.sacks', side: 'def', label: 'Sacks', short: 'Sacks', better: 'high', value: (t) => per(t.def.sacksTaken, t.games), total: (t) => t.def.sacksTaken, fmt: 'count' },
  { key: 'def.ints', side: 'def', label: 'Interceptions', short: 'INT', better: 'high', value: (t) => per(t.def.intThrown, t.games), total: (t) => t.def.intThrown, fmt: 'count' },
  { key: 'def.fumbles', side: 'def', label: 'Fumbles recovered', short: 'FR', better: 'high', value: (t) => per(t.def.fumblesLost, t.games), total: (t) => t.def.fumblesLost, fmt: 'count' },
  { key: 'def.takeaways', side: 'def', label: 'Takeaways', short: 'Takeaways', better: 'high', value: (t) => per(t.def.turnovers, t.games), total: (t) => t.def.turnovers, fmt: 'count' },
  { key: 'def.passTd', side: 'def', label: 'Passing TDs allowed', short: 'Pass TD', better: 'low', value: (t) => per(t.def.passTd, t.games), total: (t) => t.def.passTd, fmt: 'count' },
  { key: 'def.rushTd', side: 'def', label: 'Rushing TDs allowed', short: 'Rush TD', better: 'low', value: (t) => per(t.def.rushTd, t.games), total: (t) => t.def.rushTd, fmt: 'count' },
  { key: 'def.third', side: 'def', label: '3rd-down % allowed', short: '3rd %', better: 'low', value: (t) => ratio(t.def.thirdMade, t.def.thirdAtt), fmt: 'pct' },
  { key: 'def.qbRush', side: 'def', label: 'QB rush yards allowed', short: 'QB rush/g', better: 'low', value: (t) => per(t.def.qbRushYards, t.games), fmt: 'dec1' },
  { key: 'def.compPct', side: 'def', label: 'Completion % allowed', short: 'Comp %', better: 'low', value: (t) => ratio(t.def.completions, t.def.passAtt), fmt: 'pct' },
  { key: 'def.ypa', side: 'def', label: 'Yards per pass allowed', short: 'Y/A', better: 'low', value: (t) => ratio(t.def.passYards, t.def.passAtt + t.def.sacksTaken), fmt: 'dec1' },
  { key: 'def.top', side: 'def', label: "Opponents' time of possession", short: 'Opp TOP', better: 'low', value: (t) => (t.def.possessionSec ? per(t.def.possessionSec, t.games) : null), fmt: 'clock' },
  { key: 'off.top', side: 'off', label: 'Time of possession', short: 'TOP', better: 'high', value: (t) => (t.off.possessionSec ? per(t.off.possessionSec, t.games) : null), fmt: 'clock' },
];

// Standard competition ranking (1, 2, 2, 4); teams with no value get no rank.
function rankBy(teams, valueOf, better) {
  const vals = teams.map((t) => ({ abbr: t.abbr, v: valueOf(t) })).filter((x) => x.v != null && isFinite(x.v));
  vals.sort((a, b) => (better === 'low' ? a.v - b.v : b.v - a.v));
  const ranks = {};
  vals.forEach((x, i) => {
    ranks[x.abbr] = i > 0 && Math.abs(x.v - vals[i - 1].v) < 1e-9 ? ranks[vals[i - 1].abbr] : i + 1;
  });
  return ranks;
}

function teamRankings(agg) {
  const teams = Object.values(agg).filter((t) => t.games > 0);
  const ranks = {};
  for (const m of METRICS) ranks[m.key] = rankBy(teams, m.value, m.better);
  // O-line: average of the sack-rate-allowed and yards-per-carry ranks (protection + run blocking)
  const olineScore = (t) => {
    const a = ranks['off.sackRate'][t.abbr];
    const b = ranks['off.ypc'][t.abbr];
    return a && b ? (a + b) / 2 : null;
  };
  ranks['off.oline'] = rankBy(teams, olineScore, 'low');
  const rows = teams.map((t) => {
    const values = {};
    const totals = {};
    for (const m of METRICS) {
      values[m.key] = m.value(t);
      if (m.total) totals[m.key] = m.total(t);
    }
    values['off.oline'] = olineScore(t);
    const rk = {};
    for (const k of Object.keys(ranks)) rk[k] = ranks[k][t.abbr] || null;
    // last 3 games, for "how has this defense played lately"
    const last = t.log.slice(-3);
    const avgOf = (f) => (last.length && last.every((g) => g[f] != null) ? last.reduce((a, g) => a + g[f], 0) / last.length : null);
    const recent = { games: last.length, 'def.points': avgOf('pa'), 'def.yards': avgOf('yardsAllowed'), 'def.rush': avgOf('rushAllowed'), 'def.pass': avgOf('passAllowed'), 'def.qbRush': avgOf('qbRushAllowed') };
    return { abbr: t.abbr, games: t.games, values, totals, ranks: rk, recent };
  });
  return rows.sort((a, b) => a.abbr.localeCompare(b.abbr));
}

// ---------- standings ----------

function standings(games) {
  const rec = {};
  const get = (a) => (rec[a] = rec[a] || { abbr: a, w: 0, l: 0, t: 0, pf: 0, pa: 0, divW: 0, divL: 0, divT: 0, confW: 0, confL: 0, confT: 0, results: [] });
  for (const g of games.slice().sort((a, b) => a.date.localeCompare(b.date))) {
    const [a, b] = g.teams;
    for (const [me, op] of [[a, b], [b, a]]) {
      const r = get(me.abbr);
      const res = me.points > op.points ? 'W' : me.points < op.points ? 'L' : 'T';
      r[{ W: 'w', L: 'l', T: 't' }[res]]++;
      r.pf += me.points;
      r.pa += op.points;
      r.results.push(res);
      if (DIVISION_OF[me.abbr] && DIVISION_OF[me.abbr] === DIVISION_OF[op.abbr]) r[{ W: 'divW', L: 'divL', T: 'divT' }[res]]++;
      if (conferenceOf(me.abbr) && conferenceOf(me.abbr) === conferenceOf(op.abbr)) r[{ W: 'confW', L: 'confL', T: 'confT' }[res]]++;
    }
  }
  const pct = (w, l, t) => (w + l + t ? (w + t / 2) / (w + l + t) : 0);
  return DIVISIONS.map(([name, abbrs]) => ({
    name,
    teams: abbrs
      .map((abbr) => {
        const r = rec[abbr] || get(abbr);
        const last = r.results[r.results.length - 1];
        let n = 0;
        for (let i = r.results.length - 1; i >= 0 && r.results[i] === last; i--) n++;
        return {
          abbr, w: r.w, l: r.l, t: r.t, pct: pct(r.w, r.l, r.t), pf: r.pf, pa: r.pa, diff: r.pf - r.pa,
          div: `${r.divW}-${r.divL}${r.divT ? `-${r.divT}` : ''}`, divPct: pct(r.divW, r.divL, r.divT),
          conf: `${r.confW}-${r.confL}${r.confT ? `-${r.confT}` : ''}`, confPct: pct(r.confW, r.confL, r.confT),
          streak: last ? `${last}${n}` : '', last5: r.results.slice(-5).join(''),
        };
      })
      // win %, then division record, conference record and point differential (not every NFL tiebreaker)
      .sort((x, y) => y.pct - x.pct || y.divPct - x.divPct || y.confPct - x.confPct || y.diff - x.diff || x.abbr.localeCompare(y.abbr)),
  }));
}

// ---------- outliers ----------

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const OUTLIER_METRICS = [
  { key: 'def.points', field: 'pa', side: 'def', what: 'points allowed', unit: 'points', minGap: 14, minShift: 2 },
  { key: 'def.yards', field: 'yardsAllowed', side: 'def', what: 'yards allowed', unit: 'yards', minGap: 140, minShift: 20 },
  { key: 'off.points', field: 'pf', side: 'off', what: 'points scored', unit: 'points', minGap: 14, minShift: 2 },
  { key: 'off.yards', field: 'yards', side: 'off', what: 'yards gained', unit: 'yards', minGap: 140, minShift: 20 },
];

// A game is an outlier when it sits far from the team's other games (at least minGap, and well
// outside their usual spread) and removing it moves the average by at least minShift.
// rows: teamRankings() output, used to show how far the team's rank moves without that game.
function outliers(agg, rows, { minGames = 4 } = {}) {
  const out = [];
  const byAbbr = Object.fromEntries(rows.map((r) => [r.abbr, r]));
  for (const t of Object.values(agg)) {
    if (t.log.length < minGames) continue;
    for (const m of OUTLIER_METRICS) {
      const vals = t.log.map((g) => g[m.field]);
      if (vals.some((v) => v == null)) continue;
      t.log.forEach((g, i) => {
        const others = vals.filter((_, j) => j !== i);
        const med = median(others);
        const mad = median(others.map((v) => Math.abs(v - med))) * 1.4826;
        const gap = g[m.field] - med;
        if (Math.abs(gap) < Math.max(m.minGap, 2.5 * mad)) return;
        const avg = mean(vals);
        const avgWithout = mean(others);
        if (Math.abs(avg - avgWithout) < m.minShift) return;

        // where the team would rank on this stat without that game
        const metric = METRICS.find((x) => x.key === m.key);
        const peers = rows.filter((r) => r.abbr !== t.abbr && r.values[m.key] != null).map((r) => r.values[m.key]);
        const better = (a, b) => (metric.better === 'low' ? a < b : a > b);
        const rankWithout = 1 + peers.filter((v) => better(v, avgWithout)).length;
        const rankNow = byAbbr[t.abbr] ? byAbbr[t.abbr].ranks[m.key] : null;

        // only worth pointing out if it changes the picture: the rank moves or the average moves a lot
        if (rankNow != null && Math.abs(rankNow - rankWithout) < 2 && Math.abs(avg - avgWithout) < 2 * m.minShift) return;

        // flatters: the game makes the team look better than its other games do
        const flatters = metric.better === 'low' ? gap < 0 : gap > 0;
        out.push({
          team: t.abbr, metric: m.key, side: m.side, what: m.what, unit: m.unit,
          gameId: g.id, date: g.date, opp: g.opp, home: g.home, value: g[m.field],
          others: { min: Math.min(...others), max: Math.max(...others), median: med, count: others.length },
          avg, avgWithout, rankNow, rankWithout, flatters,
          impact: Math.abs(avg - avgWithout) / (m.unit === 'yards' ? 10 : 1) + Math.abs((rankNow || rankWithout) - rankWithout) / 4,
        });
      });
    }
  }
  // one entry per game and side: keep the bigger effect, mention the other (points vs yards)
  const merged = new Map();
  for (const o of out.sort((a, b) => b.impact - a.impact)) {
    const k = `${o.team}|${o.side}|${o.gameId}`;
    if (!merged.has(k)) merged.set(k, { ...o, also: [] });
    else merged.get(k).also.push({ metric: o.metric, what: o.what, unit: o.unit, value: o.value, avg: o.avg, avgWithout: o.avgWithout, rankNow: o.rankNow, rankWithout: o.rankWithout });
  }
  return [...merged.values()];
}

function buildRankings(games) {
  const agg = aggregate(games);
  const rows = teamRankings(agg);
  return {
    teams: rows,
    standings: standings(games),
    outliers: outliers(agg, rows),
    games: games.length,
    metrics: [...METRICS.map(({ key, side, label, short, better, fmt, total }) => ({ key, side, label, short, better, fmt, total: !!total })),
      { key: 'off.oline', side: 'off', label: 'O-line', short: 'O-line', better: 'low', fmt: 'olineScore', total: false }],
  };
}

// ---------- matchup notes for prop research ----------

// Which opponent rankings matter for a prop. Most look at the opponent's defense; props for
// defensive players (sacks, tackles) look at the opponent's offense instead.
const PROP_FACTORS = [
  [/^(passing yards|passing tds|pass completions|pass attempts)$/i, ['def.pass', 'def.ypa', 'def.compPct', 'def.passTd', 'def.sacks', 'def.ints', 'def.top']],
  [/^interceptions thrown$/i, ['def.ints', 'def.takeaways', 'def.sacks', 'def.compPct', 'def.pass']],
  [/^(rushing yards|rushing attempts)$/i, ['def.rush', 'def.ypc', 'def.rushTd', 'def.top', 'def.yards', 'def.points']],
  [/^(receiving yards|receptions|longest reception)$/i, ['def.pass', 'def.ypa', 'def.compPct', 'def.passTd', 'def.top']],
  [/^rush \+ rec yards$/i, ['def.rush', 'def.ypc', 'def.pass', 'def.ypa', 'def.yards', 'def.top']],
  [/td/i, ['def.points', 'def.passTd', 'def.rushTd', 'def.yards', 'def.third']],
  [/^(sacks)$/i, ['off.sackRate', 'off.pass', 'off.top']],
  [/^(tackles \+ assists)$/i, ['off.top', 'off.rush', 'off.yards']],
  [/^(kicking points|field goals made|team total|first half)$/i, ['def.points', 'def.yards', 'def.third', 'def.takeaways', 'def.top']],
];
// props where a strong opponent helps the Over (an interception-happy defense, say)
const INVERTED_PROPS = /^interceptions thrown$/i;

// rows: buildRankings().teams. Returns notes on `opp` for `team`'s player prop, or null.
function matchupNotes({ teams: rows, outliers: outs = [], metrics }, { opp, prop, side = 'Over', qb = false }) {
  const o = rows.find((r) => r.abbr === opp);
  if (!o) return null;
  let keys = (PROP_FACTORS.find(([re]) => re.test(prop || '')) || [null, ['def.yards', 'def.points', 'def.third', 'def.takeaways']])[1].slice();
  if (qb && /^(rushing yards|rushing attempts)$/i.test(prop)) keys = ['def.qbRush', ...keys];
  if (qb && /^rush \+ rec yards$/i.test(prop)) keys = ['def.qbRush', ...keys];
  const n = rows.length;
  const over = !/^(under|no)$/i.test(side);
  const invert = INVERTED_PROPS.test(prop || '');
  const meta = Object.fromEntries((metrics || METRICS).map((m) => [m.key, m]));
  const factors = keys
    .filter((k) => meta[k] && o.values[k] != null && o.ranks[k] != null)
    .map((k) => {
      const rank = o.ranks[k];
      // rank 1 = the best unit in the league at this, i.e. the hardest for the player
      const tier = rank <= Math.ceil(n / 3) ? 'strong' : rank > n - Math.ceil(n / 3) ? 'weak' : 'middle';
      let lean = tier === 'middle' ? 0 : tier === 'weak' ? 1 : -1; // +1 helps the Over
      if (invert) lean = -lean;
      if (!over) lean = -lean;
      const recent = o.recent && o.recent[k] != null && o.recent.games >= 3 ? o.recent[k] : null;
      const season = o.values[k];
      const trend = recent != null && season ? (recent - season) / season : null;
      return { key: k, label: meta[k].label, side: meta[k].side, fmt: meta[k].fmt, value: season, total: o.totals[k] ?? null, rank, of: n, lean, recent: trend != null && Math.abs(trend) >= 0.15 ? { value: recent, games: o.recent.games, change: trend } : null };
    });
  const top = factors.slice(0, 3);
  const score = top.reduce((a, f) => a + f.lean, 0);
  const verdict = score >= 2 ? 'favorable' : score <= -2 ? 'tough' : 'mixed';
  const skew = outs.filter((x) => x.team === opp && x.side === (factors[0] ? factors[0].side : 'def')).slice(0, 2);
  const sideLabel = over ? (/^yes$/i.test(side) ? 'Yes' : 'Over') : /^no$/i.test(side) ? 'No' : 'Under';
  return { opp, prop, side: sideLabel, qb, verdict, factors, outliers: skew, games: o.games };
}

// ---------- game matchup (spread, moneyline, total) ----------

// Each pair: a team's offense against the other team's defense in the same area.
const UNIT_PAIRS = [
  ['Points', 'off.points', 'def.points'],
  ['Total yards', 'off.yards', 'def.yards'],
  ['Passing', 'off.pass', 'def.pass'],
  ['Rushing', 'off.rush', 'def.rush'],
  ['Yards per carry', 'off.ypc', 'def.ypc'],
  ['3rd down', 'off.third', 'def.third'],
  ['Turnovers vs takeaways', 'off.turnovers', 'def.takeaways'],
  ['Sacks allowed vs sacks', 'off.sackRate', 'def.sacks'],
];
const EDGE_GAP = 8; // ranks apart before one side gets the edge

function gameMatchup(data, { team, opp }) {
  const rows = data.teams || [];
  const A = rows.find((r) => r.abbr === team);
  const B = rows.find((r) => r.abbr === opp);
  if (!A || !B) return null;
  const n = rows.length;
  const unit = (offTeam, defTeam) =>
    UNIT_PAIRS.map(([label, ok, dk]) => {
      const o = { value: offTeam.values[ok], total: offTeam.totals[ok] ?? null, rank: offTeam.ranks[ok] };
      const d = { value: defTeam.values[dk], total: defTeam.totals[dk] ?? null, rank: defTeam.ranks[dk] };
      if (o.rank == null || d.rank == null) return null;
      const edge = d.rank - o.rank >= EDGE_GAP ? 'off' : o.rank - d.rank >= EDGE_GAP ? 'def' : null;
      return { label, off: { key: ok, ...o }, def: { key: dk, ...d }, edge };
    }).filter(Boolean);
  const aOff = unit(A, B); // team's offense vs opp's defense
  const bOff = unit(B, A); // opp's offense vs team's defense
  const edges = {
    [team]: aOff.filter((u) => u.edge === 'off').length + bOff.filter((u) => u.edge === 'def').length,
    [opp]: bOff.filter((u) => u.edge === 'off').length + aOff.filter((u) => u.edge === 'def').length,
  };
  // season-average "on paper" score: average of what each offense scores and the other defense allows
  const pts = (off, def) => (off.values['off.points'] != null && def.values['def.points'] != null ? (off.values['off.points'] + def.values['def.points']) / 2 : null);
  const tp = pts(A, B);
  const op = pts(B, A);
  const st = Object.fromEntries((data.standings || []).flatMap((d) => d.teams).map((t) => [t.abbr, t]));
  const rec = (abbr) => (st[abbr] ? { w: st[abbr].w, l: st[abbr].l, t: st[abbr].t, diff: st[abbr].diff, streak: st[abbr].streak, last5: st[abbr].last5 } : null);
  const top = (r) => r.values['off.top'] ?? null;
  return {
    team, opp, of: n,
    records: { [team]: rec(team), [opp]: rec(opp) },
    units: [
      { offense: team, defense: opp, rows: aOff },
      { offense: opp, defense: team, rows: bOff },
    ],
    edges,
    onPaper: tp != null && op != null ? { [team]: tp, [opp]: op, total: tp + op, margin: tp - op } : null,
    possession: { [team]: top(A), [opp]: top(B) },
    outliers: (data.outliers || []).filter((o) => (o.team === team || o.team === opp) && /points/.test(o.what)).slice(0, 3),
  };
}

module.exports = { DIVISIONS, TEAMS, PARSE_VERSION, matchupNotes, gameMatchup, parseTeamGame, aggregate, teamRankings, standings, outliers, buildRankings, METRICS };
