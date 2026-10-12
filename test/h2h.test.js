'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seasonsToSearch, meetingsFromSchedule, parseGameSummary, summarizeH2H } = require('../lib/h2h');

test('seasonsToSearch picks the right season years', () => {
  assert.deepStrictEqual(seasonsToSearch('nfl', new Date('2026-10-12T00:00:00Z')), [2026, 2025, 2024, 2023]);
  assert.deepStrictEqual(seasonsToSearch('nfl', new Date('2027-01-20T00:00:00Z')), [2026, 2025, 2024, 2023]);
  assert.deepStrictEqual(seasonsToSearch('nba', new Date('2026-10-12T00:00:00Z')), [2027, 2026, 2025]);
  assert.deepStrictEqual(seasonsToSearch('nba', new Date('2026-03-01T00:00:00Z')), [2026, 2025, 2024]);
});

test('meetingsFromSchedule keeps completed games against the opponent', () => {
  const ev = (id, opp, completed, type = 2) => ({
    id, date: `2025-1${id}-01T17:00Z`, seasonType: { type },
    competitions: [{ status: { type: { completed } }, competitors: [{ team: { abbreviation: 'KC' } }, { team: { abbreviation: opp } }] }],
  });
  const m = meetingsFromSchedule({ events: [ev('1', 'BUF', true), ev('2', 'DEN', true), ev('3', 'BUF', false), ev('4', 'BUF', true, 3)] }, 'BUF');
  assert.deepStrictEqual(m.map((x) => [x.id, x.postseason]), [['1', false], ['4', true]]);
  assert.deepStrictEqual(meetingsFromSchedule(null, 'BUF'), []);
});

const nflSummary = {
  header: {
    id: '401',
    competitions: [{
      date: '2025-11-16T21:25Z',
      competitors: [
        { homeAway: 'home', score: '38', winner: true, team: { abbreviation: 'KC', displayName: 'Kansas City Chiefs' } },
        { homeAway: 'away', score: '10', winner: false, team: { abbreviation: 'BUF', displayName: 'Buffalo Bills' } },
      ],
    }],
  },
  leaders: [
    { team: { abbreviation: 'KC' }, leaders: [
      { name: 'passingYards', displayName: 'Passing Yards', leaders: [{ value: 312, displayValue: '25/34, 312 YDS, 3 TD', athlete: { displayName: 'Patrick Mahomes', position: { abbreviation: 'QB' } } }] },
      { name: 'rushingYards', displayName: 'Rushing Yards', leaders: [{ value: 64, displayValue: '14 CAR, 64 YDS', athlete: { displayName: 'Isiah Pacheco' } }] },
    ] },
    { team: { abbreviation: 'BUF' }, leaders: [
      { name: 'receivingYards', displayName: 'Receiving Yards', leaders: [{ value: 41, displayValue: '4 REC, 41 YDS, 2 TD', athlete: { displayName: 'Khalil Shakir' } }] },
    ] },
  ],
  boxscore: { teams: [
    { team: { abbreviation: 'KC' }, statistics: [{ name: 'totalYards', displayValue: '466' }, { name: 'turnovers', displayValue: '0' }] },
    { team: { abbreviation: 'BUF' }, statistics: [{ name: 'totalYards', displayValue: '250' }, { name: 'turnovers', displayValue: '3' }] },
  ] },
};

test('parseGameSummary extracts score, leaders and notable storylines', () => {
  const g = parseGameSummary(nflSummary, 'nfl');
  assert.strictEqual(g.winner, 'KC');
  assert.strictEqual(g.margin, 28);
  assert.strictEqual(g.total, 48);
  assert.deepStrictEqual(g.stats.KC, { yards: 466, turnovers: 0 });
  const big = g.leaders.filter((l) => l.big).map((l) => l.player);
  assert.deepStrictEqual(big, ['Patrick Mahomes', 'Khalil Shakir']); // 300+ yds/3 TD; 2 rec TD
  const types = g.notes.map((n) => n.type).sort();
  assert.deepStrictEqual(types, ['blowout', 'defense', 'offense']);
  assert.match(g.notes.find((n) => n.type === 'defense').text, /forced 3 TO/);
  assert.strictEqual(parseGameSummary({}, 'nfl'), null);
});

test('parseGameSummary NBA rules', () => {
  const g = parseGameSummary({
    header: { competitions: [{ competitors: [
      { homeAway: 'home', score: '131', team: { abbreviation: 'BOS' } },
      { homeAway: 'away', score: '129', team: { abbreviation: 'NY' } },
    ] }] },
    leaders: [{ team: { abbreviation: 'BOS' }, leaders: [{ name: 'points', displayName: 'Points', leaders: [{ value: 41, displayValue: '41', athlete: { displayName: 'Jayson Tatum' } }] }] }],
  }, 'nba');
  assert.strictEqual(g.leaders[0].big, true);
  assert.ok(g.notes.some((n) => n.type === 'close'));
  assert.ok(g.notes.some((n) => n.type === 'offense' && n.team === 'BOS'));
});

test('summarizeH2H computes series record and averages from team A view', () => {
  const g1 = parseGameSummary(nflSummary, 'nfl'); // KC 38-10
  const g2 = { teams: [{ abbr: 'KC', score: 20 }, { abbr: 'BUF', score: 24 }], winner: 'BUF', total: 44 };
  const s = summarizeH2H([g1, g2], 'BUF', 'KC');
  assert.deepStrictEqual(s.wins, { BUF: 1, KC: 1 });
  assert.strictEqual(s.avgTotal, 46);
  assert.strictEqual(s.avgMargin, -12);
});
