'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/trends');

const games = [70, 82, 40, 91, 77, 104, 88].map((y, i) => ({ id: 'g' + i, date: `2025-10-0${i + 1}T17:00Z`, opp: 'X' + i, home: i % 2 === 0, y }));
const boxes = Object.fromEntries(games.map((g) => [g.id, { players: {
  'derrick henry': { name: 'Derrick Henry', team: 'BAL', stats: { 'rushing.YDS': g.y, 'rushing.TD': g.y > 85 ? 1 : 0 } },
  'other guy': { name: 'Other Guy', team: 'PIT', stats: { 'rushing.YDS': 200 } },
} }]));

test('playerLogs keeps only the team\'s players, oldest to newest', () => {
  const logs = T.playerLogs(games, boxes, 'BAL');
  assert.deepStrictEqual(Object.keys(logs), ['derrick henry']);
  assert.deepStrictEqual(logs['derrick henry'].games.map((g) => g.stats['rushing.YDS']), [70, 82, 40, 91, 77, 104, 88]);
});

test('milestoneStreaks finds the highest milestone currently on a run', () => {
  const logs = T.playerLogs(games, boxes, 'BAL');
  const items = T.milestoneStreaks(logs, 'nfl');
  const rush = items.find((x) => x.category === 'Rushing Yards');
  assert.strictEqual(rush.threshold, 75); // 91, 77, 104, 88 -> 4 straight 75+ (not 100+)
  assert.strictEqual(rush.streak, 4);
  assert.strictEqual(rush.text, '75+ rushing yards in 4 straight games');
  assert.deepStrictEqual(rush.suggest, { betType: 'Player Prop', propCategory: 'Rushing Yards', side: 'Over', line: 74.5 });
  assert.ok(!items.find((x) => x.category === 'Anytime TD')); // TD streak is only 1 (88 > 85 yes, 104 yes, 77 no) -> 2
});

test('propLineStreaks compares recent games with the consensus line', () => {
  const logs = { BAL: T.playerLogs(games, boxes, 'BAL') };
  const [over] = T.propLineStreaks(logs, [{ player: 'Derrick Henry', category: 'Rushing Yards', line: 72.5, over: { price: -115, book: 'FanDuel' } }], 'nfl');
  assert.strictEqual(over.side, 'Over');
  assert.strictEqual(over.streak, 4);
  assert.strictEqual(over.hits, 5);
  assert.deepStrictEqual(over.price, { price: -115, book: 'FanDuel' });
  const [under] = T.propLineStreaks(logs, [{ player: 'D. Henry', category: 'Rushing Yards', line: 120.5 }], 'nfl');
  assert.strictEqual(under.side, 'Under');
  assert.strictEqual(under.streak, 7);
  assert.strictEqual(T.propLineStreaks(logs, [{ player: 'Nobody', category: 'Rushing Yards', line: 50 }], 'nfl').length, 0);
});

test('teamTrends surfaces streaks and situations that apply to the game', () => {
  const niche = {
    abbr: 'KC',
    atsStreak: { type: 'W', length: 4 },
    ouStreak: { type: 'U', length: 3 },
    ou: { over: 3, under: 9, n: 12 },
    ats: [
      { key: 'last10', w: 8, l: 2, p: 0, n: 10 },
      { key: 'snf', w: 5, l: 1, p: 0, n: 6 },
      { key: 'mnf', w: 1, l: 4, p: 0, n: 5 },
      { key: 'home', w: 6, l: 5, p: 0, n: 11 },
      { key: 'dog', w: 4, l: 0, p: 0, n: 4 },
    ],
  };
  const items = T.teamTrends(niche, { opp: 'BUF', home: true, slots: { snf: true, primetime: true }, favorite: 'BUF' });
  const texts = items.map((x) => x.text);
  assert.ok(texts.includes('has covered 4 straight'));
  assert.ok(texts.includes('is 8-2 against the spread in the last 10'));
  assert.ok(texts.includes('games have gone under the total 3 straight'));
  assert.ok(texts.includes('is 5-1 ATS on Sunday nights'));
  assert.ok(texts.includes('is 4-0 ATS as an underdog'));
  assert.ok(!texts.some((t) => /Monday/.test(t))); // not a Monday game
  assert.ok(!texts.some((t) => /at home/.test(t))); // 6-5 isn't a trend
  assert.deepStrictEqual(T.teamTrends({ error: 'x' }, {}), []);
});
