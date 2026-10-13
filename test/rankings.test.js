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
