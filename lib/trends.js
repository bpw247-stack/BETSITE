'use strict';

// Streaks & trends for the Market tab:
// - teamTrends: ATS / over-under streaks and situational ATS records that apply to an upcoming game
// - playerLogs + milestoneStreaks: players on a run of hitting a stat milestone (e.g. 75+ rush yds)
// - propLineStreaks: players on a run against the current consensus prop line
// Pure functions; the server feeds them ESPN data.

const { statForProp, normName } = require('./grading');

const MILESTONES = {
  nfl: [
    ['Passing Yards', [225, 250, 275, 300]], ['Passing TDs', [2, 3]], ['Rushing Yards', [50, 75, 100]],
    ['Receiving Yards', [50, 75, 100]], ['Receptions', [4, 5, 6, 8]], ['Rush + Rec Yards', [75, 100, 125]], ['Anytime TD', [1]],
  ],
  nba: [
    ['Points', [15, 20, 25, 30, 35]], ['Rebounds', [8, 10, 12]], ['Assists', [6, 8, 10]], ['3-Pointers Made', [2, 3, 4, 5]],
    ['Pts + Reb + Ast', [30, 35, 40, 45]], ['Steals + Blocks', [2, 3]],
  ],
};
const milestoneLabel = (cat, t) => (cat === 'Anytime TD' ? 'scored a TD' : `${t}+ ${cat.replace('Passing TDs', 'passing TDs').toLowerCase()}`);

// Per-player game logs (oldest -> newest) for one team from box scores.
// games: [{ id, date, opp, home }] oldest -> newest; boxes: { [id]: parsedBoxScore }
function playerLogs(games, boxes, team) {
  const logs = {};
  for (const g of games) {
    const box = boxes[g.id];
    if (!box || !box.players) continue;
    for (const p of Object.values(box.players)) {
      if (p.team !== team) continue;
      const k = normName(p.name);
      (logs[k] = logs[k] || { name: p.name, team, games: [] }).games.push({ date: g.date, opp: g.opp, home: g.home, stats: p.stats });
    }
  }
  return logs;
}

const valuesFor = (log, league, cat) => log.games.map((g) => {
  const v = statForProp(league, cat, g.stats);
  return v == null ? 0 : v;
});

function streakFrom(values, test) {
  let n = 0;
  for (let i = values.length - 1; i >= 0 && test(values[i]); i--) n++;
  return n;
}

// Best milestone streak per player & category (streak >= minStreak games, most recent first).
function milestoneStreaks(logs, league, { minStreak = 3, minGames = 5 } = {}) {
  const out = [];
  for (const log of Object.values(logs)) {
    if (log.games.length < minGames) continue;
    for (const [cat, steps] of MILESTONES[league] || []) {
      const vals = valuesFor(log, league, cat);
      const last10 = vals.slice(-10);
      // highest milestone the player is currently streaking at
      let best = null;
      for (const t of steps) {
        const streak = streakFrom(vals, (v) => v >= t);
        if (streak >= minStreak) best = { t, streak };
      }
      if (!best) continue;
      out.push({
        kind: 'milestone',
        player: log.name,
        team: log.team,
        category: cat,
        threshold: best.t,
        text: `${milestoneLabel(cat, best.t)} in ${best.streak} straight games`,
        streak: best.streak,
        hits: last10.filter((v) => v >= best.t).length,
        of: last10.length,
        avg: Math.round((last10.reduce((a, b) => a + b, 0) / last10.length) * 10) / 10,
        recent: last10.slice(-5),
        // suggested prop: just under the milestone (e.g. 74.5 for 75+)
        suggest: { betType: 'Player Prop', propCategory: cat, side: cat === 'Anytime TD' ? 'Yes' : 'Over', line: cat === 'Anytime TD' ? '' : best.t - 0.5 },
        score: best.streak + (last10.filter((v) => v >= best.t).length / Math.max(1, last10.length)) * 3,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// Streaks vs this week's consensus lines. props: [{ player, category, line }]
function propLineStreaks(logsByTeam, props, league, { minStreak = 3 } = {}) {
  const out = [];
  const allLogs = Object.values(logsByTeam).flatMap((l) => Object.values(l));
  for (const p of props) {
    if (p.line == null || statForProp(league, p.category, {}) === undefined) continue;
    const key = normName(p.player);
    const last = key.split(' ').pop();
    const log = allLogs.find((l) => normName(l.name) === key) || (allLogs.filter((l) => normName(l.name).split(' ').pop() === last).length === 1 ? allLogs.find((l) => normName(l.name).split(' ').pop() === last) : null);
    if (!log || log.games.length < 4) continue;
    const vals = valuesFor(log, league, p.category);
    const last10 = vals.slice(-10);
    const overs = last10.filter((v) => v > p.line).length;
    const unders = last10.filter((v) => v < p.line).length;
    const overStreak = streakFrom(vals, (v) => v > p.line);
    const underStreak = streakFrom(vals, (v) => v < p.line);
    const side = overStreak >= underStreak ? 'Over' : 'Under';
    const streak = Math.max(overStreak, underStreak);
    const hits = side === 'Over' ? overs : unders;
    if (streak < minStreak && !(last10.length >= 6 && hits / last10.length >= 0.7)) continue;
    out.push({
      kind: 'propline',
      player: log.name,
      team: log.team,
      category: p.category,
      line: p.line,
      side,
      text: `${side} ${p.line} ${p.category.toLowerCase()}: ${hits} of last ${last10.length}${streak >= 2 ? `, ${streak} straight` : ''}`,
      streak,
      hits,
      of: last10.length,
      avg: Math.round((last10.reduce((a, b) => a + b, 0) / last10.length) * 10) / 10,
      recent: last10.slice(-5),
      price: p[side === 'Over' ? 'over' : 'under'] || null,
      suggest: { betType: 'Player Prop', propCategory: p.category, side, line: p.line },
      score: streak + (hits / Math.max(1, last10.length)) * 5,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

const pct = (w, l) => (w + l ? w / (w + l) : null);

// Trend items for one team ahead of a game. niche: getTeamNiche() result.
// ctx: { opp, home, slots: { mnf, snf, tnf, primetime }, favorite }
function teamTrends(niche, ctx) {
  const out = [];
  if (!niche || niche.error) return out;
  const t = niche.abbr;
  const add = (kind, text, score, extra = {}) => out.push({ kind, team: t, opp: ctx.opp, text, score, ...extra });
  const s = niche.atsStreak;
  if (s && s.length >= 3) {
    add('ats', s.type === 'W' ? `has covered ${s.length} straight` : `has failed to cover ${s.length} straight`, s.length + 1, {
      lean: s.type === 'W' ? 'with' : 'against',
      suggest: { betType: 'Spread', side: s.type === 'W' ? 'team' : 'opp' },
    });
  }
  const find = (k) => (niche.ats || []).find((x) => x.key === k);
  const l10 = find('last10');
  if (l10 && l10.n >= 8) {
    const r = pct(l10.w, l10.l);
    if (r >= 0.7 || r <= 0.3) add('ats', `is ${l10.w}-${l10.l}${l10.p ? '-' + l10.p : ''} against the spread in the last ${l10.n}`, Math.abs(r - 0.5) * 10, { lean: r >= 0.7 ? 'with' : 'against', suggest: { betType: 'Spread', side: r >= 0.7 ? 'team' : 'opp' } });
  }
  const o = niche.ouStreak;
  if (o && o.length >= 3) add('ou', `games have gone ${o.type === 'O' ? 'over' : 'under'} the total ${o.length} straight`, o.length + 0.5, { suggest: { betType: 'Total', side: o.type === 'O' ? 'Over' : 'Under' } });
  if (niche.ou && niche.ou.n >= 8) {
    const r = pct(niche.ou.over, niche.ou.under);
    if (r >= 0.68 || r <= 0.32) add('ou', `games are ${niche.ou.over}-${niche.ou.under} to the over (last ${niche.ou.n} with a total)`, Math.abs(r - 0.5) * 8, { suggest: { betType: 'Total', side: r >= 0.5 ? 'Over' : 'Under' } });
  }
  // situations that apply to this game
  const situational = [];
  for (const k of ['mnf', 'tnf', 'snf']) if (ctx.slots && ctx.slots[k]) situational.push(k);
  if (ctx.slots && ctx.slots.primetime) situational.push('primetime');
  situational.push(ctx.home ? 'home' : 'away');
  if (ctx.favorite) situational.push(ctx.favorite === t ? 'fav' : 'dog');
  for (const k of situational) {
    const x = find(k);
    if (!x || x.n < 4) continue;
    const r = pct(x.w, x.l);
    if (r == null || !(r >= 0.7 || r <= 0.3)) continue;
    add('situational', `is ${x.w}-${x.l}${x.p ? '-' + x.p : ''} ATS ${{ mnf: 'on Monday nights', tnf: 'on Thursday nights', snf: 'on Sunday nights', primetime: 'in primetime', home: 'at home', away: 'on the road', fav: 'as a favorite', dog: 'as an underdog' }[k]}`, Math.abs(r - 0.5) * Math.sqrt(x.n) * 2, {
      situation: k,
      lean: r >= 0.7 ? 'with' : 'against',
      suggest: { betType: 'Spread', side: r >= 0.7 ? 'team' : 'opp' },
    });
  }
  return out;
}

module.exports = { MILESTONES, playerLogs, milestoneStreaks, propLineStreaks, teamTrends };
