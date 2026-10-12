'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEspnScoreboard, espnDay } = require('../lib/schedule');

test('parses ESPN scoreboard events', () => {
  const games = parseEspnScoreboard({
    week: { number: 7 },
    events: [
      {
        id: '2',
        date: '2026-10-19T00:20Z',
        status: { type: { state: 'pre', shortDetail: '10/18 - 8:20 PM EDT' } },
        competitions: [
          {
            venue: { fullName: 'Arrowhead', address: { city: 'Kansas City', state: 'MO' } },
            broadcasts: [{ names: ['NBC'] }],
            odds: [{ details: 'KC -3.5', overUnder: 47.5 }],
            competitors: [
              { homeAway: 'home', score: '0', team: { abbreviation: 'KC', displayName: 'Kansas City Chiefs', logo: 'kc.png' }, records: [{ type: 'total', summary: '5-1' }] },
              { homeAway: 'away', score: '0', team: { abbreviation: 'BUF', displayName: 'Buffalo Bills' }, records: [{ summary: '4-2' }] },
            ],
          },
        ],
      },
      { id: '1', date: '2026-10-18T17:00Z', competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: 'DET' } }, { homeAway: 'away', team: { abbreviation: 'GB' } }] }] },
      { id: 'bad', competitions: [] },
    ],
  });
  assert.deepStrictEqual(games.map((g) => g.id), ['1', '2']); // sorted by date, bad dropped
  const g = games[1];
  assert.strictEqual(g.home.abbr, 'KC');
  assert.strictEqual(g.home.record, '5-1');
  assert.strictEqual(g.away.name, 'Buffalo Bills');
  assert.strictEqual(g.spread, 'KC -3.5');
  assert.strictEqual(g.overUnder, 47.5);
  assert.strictEqual(g.tv, 'NBC');
  assert.strictEqual(g.venue, 'Arrowhead · Kansas City, MO');
  assert.strictEqual(g.week, 7);
  assert.strictEqual(games[0].state, 'pre');
  assert.strictEqual(games[0].overUnder, null);
});

test('tolerates garbage input and formats ESPN days', () => {
  assert.deepStrictEqual(parseEspnScoreboard(null), []);
  assert.strictEqual(espnDay(new Date('2026-10-13T03:00:00Z')), '20261012');
});
