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
      },
    };
  });
  if (teams.length !== 2 || teams.some((t) => !t.abbr || t.points == null)) return null;
  for (const t of teams) {
    const s = t.stats;
    if (s.turnovers == null && (s.intThrown != null || s.fumblesLost != null)) s.turnovers = (s.intThrown || 0) + (s.fumblesLost || 0);
  }
  return { id: str(json.header && json.header.id), date: str(comp.date), teams };
}

// ---------- season totals ----------

const SUM_KEYS = ['yards', 'passYards', 'rushYards', 'rushAtt', 'completions', 'passAtt', 'intThrown', 'fumblesLost', 'turnovers', 'sacksTaken', 'thirdMade', 'thirdAtt', 'passTd', 'rushTd'];

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
    return { abbr: t.abbr, games: t.games, values, totals, ranks: rk };
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

module.exports = { DIVISIONS, TEAMS, parseTeamGame, aggregate, teamRankings, standings, outliers, buildRankings, METRICS };
