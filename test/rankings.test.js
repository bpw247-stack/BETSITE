'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/rankings');

// An ESPN-style game summary with the team box-score lines the parser reads.
function summary(id, date, home, away, line = {}) {
  const team = (abbr, t) => ({
    team: { abbreviation: abbr },
    statistics: [
      { name: 'totalYards', displayValue: String(t.yards) },
      { name: 'netPassingYards', displayValue: String(t.pass) },
      { name: 'completionAttempts', displayValue: `${t.comp}/${t.att}` },
      { name: 'interceptions', displayValue: String(t.int) },
      { name: 'sacksYardsLost', displayValue: `${t.sacks}-${t.sacks * 7}` },
      { name: 'rushingYards', displayValue: String(t.rush) },
      { name: 'rushingAttempts', displayValue: String(t.car) },
      { name: 'thirdDownEff', displayValue: `${t.third}-12` },
      { name: 'fumblesLost', displayValue: String(t.fum) },
      { name: 'turnovers', displayValue: String(t.int + t.fum) },
    ],
  });
  const players = (abbr, t) => ({
    team: { abbreviation: abbr },
    statistics: [
      { name: 'passing', labels: ['C/ATT', 'YDS', 'TD', 'INT'], athletes: [{ athlete: { displayName: `${abbr} QB` }, stats: [`${t.comp}/${t.att}`, String(t.pass), String(t.ptd), String(t.int)] }] },
      { name: 'rushing', labels: ['CAR', 'YDS', 'TD'], athletes: [{ athlete: { displayName: `${abbr} RB` }, stats: [String(t.car), String(t.rush), String(t.rtd)] }] },
    ],
  });
  const base = { yards: 350, pass: 230, comp: 20, att: 32, int: 1, sacks: 2, rush: 120, car: 28, third: 5, fum: 0, ptd: 2, rtd: 1 };
  const h = { ...base, ...(line[home] || {}) };
  const a = { ...base, ...(line[away] || {}) };
  return {
    header: { id, competitions: [{ date, status: { type: { completed: true } }, competitors: [
      { homeAway: 'home', score: String(h.pts), team: { abbreviation: home } },
      { homeAway: 'away', score: String(a.pts), team: { abbreviation: away } },
    ] }] },
    boxscore: { teams: [team(home, h), team(away, a)], players: [players(home, h), players(away, a)] },
  };
}

test('parseTeamGame reads team totals, sacks and TDs; skips unfinished games', () => {
  const g = R.parseTeamGame(summary('1', '2026-09-10T00:20Z', 'KC', 'BUF', { KC: { pts: 27, yards: 410, pass: 300, sacks: 1, ptd: 3, rtd: 0 }, BUF: { pts: 20, rush: 90, car: 22 } }));
  assert.strictEqual(g.id, '1');
  const kc = g.teams.find((t) => t.abbr === 'KC');
  assert.strictEqual(kc.home, true);
  assert.strictEqual(kc.points, 27);
  assert.deepStrictEqual([kc.stats.yards, kc.stats.passYards, kc.stats.completions, kc.stats.passAtt, kc.stats.sacksTaken, kc.stats.passTd, kc.stats.rushTd, kc.stats.turnovers], [410, 300, 20, 32, 1, 3, 0, 1]);
  const pending = summary('2', '2026-09-11T00:20Z', 'KC', 'BUF', { KC: { pts: 0 }, BUF: { pts: 0 } });
  pending.header.competitions[0].status.type = { completed: false, state: 'in' };
  assert.strictEqual(R.parseTeamGame(pending), null);
});

// DAL allows 31, 28, 35 and then 3; everyone else plays ordinary games.
function season() {
  const games = [];
  let n = 0;
  const day = (d) => `2026-09-${String(d).padStart(2, '0')}T17:00Z`;
  const play = (d, home, away, line) => games.push(R.parseTeamGame(summary(String(++n), day(d), home, away, line)));
  play(7, 'DAL', 'PHI', { DAL: { pts: 17 }, PHI: { pts: 31, yards: 430 } });
  play(14, 'NYG', 'DAL', { DAL: { pts: 20 }, NYG: { pts: 28, yards: 410 } });
  play(21, 'DAL', 'WSH', { DAL: { pts: 24 }, WSH: { pts: 35, yards: 450 } });
  play(28, 'DAL', 'NO', { DAL: { pts: 30 }, NO: { pts: 3, yards: 180 } });
  // other teams: steady 20-ish games so DAL's swing stands out
  const others = ['KC', 'BUF', 'MIA', 'NE', 'BAL', 'CIN', 'PIT', 'CLE'];
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < others.length; i += 2) {
      play(7 + w * 7, others[i], others[i + 1], { [others[i]]: { pts: 20 + ((i + w) % 3) * 3, yards: 340 + i * 5 }, [others[i + 1]]: { pts: 21 + ((i + w) % 2) * 3, yards: 330 + w * 6 } });
    }
  }
  return games;
}

test('defense and offense rankings use per-game values and count stats keep totals', () => {
  const out = R.buildRankings(season());
  const dal = out.teams.find((t) => t.abbr === 'DAL');
  assert.strictEqual(dal.games, 4);
  assert.strictEqual(dal.values['def.points'], (31 + 28 + 35 + 3) / 4);
  assert.strictEqual(dal.totals['def.sacks'], 8); // opponents were sacked twice a game
  assert.strictEqual(dal.totals['off.passTd'], 8);
  assert.ok(dal.ranks['def.points'] >= 1);
  assert.ok(out.teams.every((t) => t.ranks['off.oline'] != null));
  const kc = out.teams.find((t) => t.abbr === 'KC');
  assert.strictEqual(kc.values['off.sackRate'], 8 / (128 + 8));
});

test('flags a defense that allowed 28+ three times and then 3, with the rank it would have without it', () => {
  const out = R.buildRankings(season());
  const o = out.outliers.find((x) => x.team === 'DAL' && x.metric === 'def.points');
  assert.ok(o, 'DAL points-allowed outlier found');
  assert.strictEqual(o.value, 3);
  assert.strictEqual(o.opp, 'NO');
  assert.strictEqual(o.others.min, 28);
  assert.strictEqual(o.avg, 24.25);
  assert.strictEqual(o.avgWithout, 94 / 3);
  assert.strictEqual(o.flatters, true);
  assert.ok(o.rankWithout > o.rankNow, 'rank gets worse without the game');
  // steady teams are not flagged
  assert.ok(!out.outliers.some((x) => x.team === 'KC'));
});

test('standings: division order by win %, with division record and streak', () => {
  const st = R.standings(season());
  const east = st.find((d) => d.name === 'NFC East');
  const dal = east.teams.find((t) => t.abbr === 'DAL');
  assert.deepStrictEqual([dal.w, dal.l, dal.div, dal.streak, dal.last5], [1, 3, '0-3', 'W1', 'LLLW']);
  assert.strictEqual(east.teams[0].abbr === 'PHI' || east.teams[0].abbr === 'NYG' || east.teams[0].abbr === 'WSH', true);
  assert.strictEqual(st.length, 8);
  assert.ok(st.every((d) => d.teams.length === 4));
});

test('QB rushing comes from players who threw passes; time of possession is read', () => {
  const s = summary('9', '2026-10-01T17:00Z', 'DEN', 'SEA', { DEN: { pts: 20 }, SEA: { pts: 17 } });
  s.boxscore.players[0].statistics[1].athletes.push({ athlete: { displayName: 'DEN QB' }, stats: ['6', '41', '1'] });
  s.boxscore.teams[0].statistics.push({ name: 'possessionTime', displayValue: '32:45' });
  const g = R.parseTeamGame(s);
  const den = g.teams.find((t) => t.abbr === 'DEN');
  assert.strictEqual(g.v, R.PARSE_VERSION);
  assert.deepStrictEqual([den.stats.qbRushYards, den.stats.qbRushAtt, den.stats.possessionSec], [41, 6, 32 * 60 + 45]);
  assert.strictEqual(g.teams.find((t) => t.abbr === 'SEA').stats.qbRushYards, 0);
});

test('matchup notes: weak run defense helps a rushing Over, hurts the Under; QBs see QB rush yards first', () => {
  // DAL allows lots of rushing; everyone else is steady
  const games = season().map((g) => {
    const dalOpp = g.teams.find((t) => t.abbr !== 'DAL' && g.teams.some((x) => x.abbr === 'DAL'));
    if (dalOpp) Object.assign(dalOpp.stats, { rushYards: 210, rushAtt: 30, qbRushYards: 60 });
    return g;
  });
  const data = R.buildRankings(games);
  const over = R.matchupNotes(data, { opp: 'DAL', prop: 'Rushing Yards', side: 'Over', qb: true });
  assert.strictEqual(over.factors[0].key, 'def.qbRush');
  const rush = over.factors.find((f) => f.key === 'def.rush');
  assert.strictEqual(rush.rank, data.teams.length); // worst run defense
  assert.strictEqual(rush.lean, 1);
  assert.strictEqual(over.verdict, 'favorable');
  const under = R.matchupNotes(data, { opp: 'DAL', prop: 'Rushing Yards', side: 'Under' });
  assert.strictEqual(under.factors[0].key, 'def.rush');
  assert.strictEqual(under.factors[0].lean, -1);
  assert.strictEqual(under.side, 'Under');
  assert.strictEqual(R.matchupNotes(data, { opp: 'XXX', prop: 'Rushing Yards' }), null);
  assert.strictEqual(R.matchupNotes(data, { opp: 'DAL', prop: 'Anytime TD', side: 'Yes' }).side, 'Yes');
});

test('game matchup pairs each offense with the other defense, counts edges and gives an on-paper score', () => {
  const data = R.buildRankings(season());
  const m = R.gameMatchup(data, { team: 'PHI', opp: 'DAL' });
  assert.strictEqual(m.units[0].offense, 'PHI');
  assert.strictEqual(m.units[0].defense, 'DAL');
  assert.strictEqual(m.units[0].rows[0].label, 'Points');
  assert.strictEqual(m.units[0].rows[0].off.key, 'off.points');
  assert.strictEqual(m.units[0].rows[0].def.key, 'def.points');
  for (const u of m.units) for (const r of u.rows) {
    if (r.edge === 'off') assert.ok(r.def.rank - r.off.rank >= 8);
    if (r.edge === 'def') assert.ok(r.off.rank - r.def.rank >= 8);
  }
  const phi = data.teams.find((t) => t.abbr === 'PHI');
  const dal = data.teams.find((t) => t.abbr === 'DAL');
  assert.strictEqual(m.onPaper.PHI, (phi.values['off.points'] + dal.values['def.points']) / 2);
  assert.strictEqual(m.onPaper.total, m.onPaper.PHI + m.onPaper.DAL);
  assert.deepStrictEqual([m.records.DAL.w, m.records.DAL.l], [1, 3]);
  assert.ok(m.outliers.some((o) => o.team === 'DAL'));
  assert.strictEqual(R.gameMatchup(data, { team: 'PHI', opp: 'XXX' }), null);
});

// A hand-made league where one defense is extreme in chosen stats.
function league(oppValues) {
  const keys = ['def.pass', 'def.ypa', 'def.compPct', 'def.sacks', 'def.top', 'def.rush', 'def.qbRush', 'def.ypc', 'def.ints', 'def.takeaways', 'def.points', 'def.rushTd', 'def.passTd', 'def.yards', 'def.third'];
  const better = Object.fromEntries(R.METRICS.map((m) => [m.key, m.better]));
  const teams = Array.from({ length: 32 }, (_, i) => ({ abbr: i ? `T${i}` : 'OPP', games: 6, values: {}, totals: {}, ranks: {}, recent: { games: 3 } }));
  for (const k of keys) {
    // middle of the pack by default; OPP's rank comes from oppValues (1 = best at it)
    const oppRank = oppValues[k] || 16;
    const others = Array.from({ length: 31 }, (_, i) => i + 1).map((r) => (r >= oppRank ? r + 1 : r));
    teams.forEach((t, i) => {
      t.ranks[k] = i ? others[i - 1] : oppRank;
      t.values[k] = better[k] === 'low' ? t.ranks[k] : 100 - t.ranks[k];
    });
  }
  return { teams, outliers: [] };
}

test('weighted logic: a strong pass rush helps a QB rushing Over even when the run defense is decent', () => {
  const d = league({ 'def.qbRush': 28, 'def.sacks': 1, 'def.rush': 12 });
  const m = R.matchupNotes(d, { opp: 'OPP', prop: 'Rushing Yards', side: 'Over', qb: true });
  const sacks = m.factors.find((f) => f.key === 'def.sacks');
  assert.strictEqual(sacks.inverted, true);
  assert.strictEqual(sacks.lean, 1); // the best pass rush helps the scramble Over
  assert.match(sacks.why, /scrambles/);
  assert.strictEqual(m.factors[0].key, 'def.qbRush');
  assert.strictEqual(m.factors[0].impact, 'major');
  assert.ok(m.score > 0.12, `score ${m.score}`);
  // the same matchup reads the other way for the Under
  const u = R.matchupNotes(d, { opp: 'OPP', prop: 'Rushing Yards', side: 'Under', qb: true });
  assert.strictEqual(u.score, -m.score);
});

test('weighted logic: major stats outweigh minor ones, and a great run defense helps a passing Over', () => {
  // elite pass defense (1st) but awful at minor things: still a tough spot for passing yards
  const tough = R.matchupNotes(league({ 'def.pass': 1, 'def.ypa': 2, 'def.top': 32, 'def.sacks': 32 }), { opp: 'OPP', prop: 'Passing Yards', side: 'Over' });
  assert.ok(['tough', 'lean-bad'].includes(tough.verdict), tough.verdict);
  const runD = R.matchupNotes(league({ 'def.rush': 1 }), { opp: 'OPP', prop: 'Passing Yards', side: 'Over' });
  assert.strictEqual(runD.factors.find((f) => f.key === 'def.rush').lean, 1);
  // interceptions thrown: a ball-hawking defense helps the Over
  const ints = R.matchupNotes(league({ 'def.ints': 1, 'def.takeaways': 2 }), { opp: 'OPP', prop: 'Interceptions Thrown', side: 'Over' });
  assert.ok(ints.score > 0.3 && ints.verdict === 'favorable', `${ints.verdict} ${ints.score}`);
  // anytime TD uses yes/no
  const td = R.matchupNotes(league({ 'def.points': 31, 'def.rushTd': 30, 'def.passTd': 29 }), { opp: 'OPP', prop: 'Anytime TD', side: 'No' });
  assert.strictEqual(td.side, 'No');
  assert.ok(td.score < -0.3, `${td.score}`);
});
