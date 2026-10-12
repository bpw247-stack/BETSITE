'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/stats.js');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('winProfit handles American odds', () => {
  close(S.winProfit(150, 100), 150);
  close(S.winProfit(-110, 110), 100);
  close(S.winProfit(-200, 50), 25);
  assert.strictEqual(S.winProfit(50, 100), 0); // invalid odds
});

test('betProfit by result and override', () => {
  assert.strictEqual(S.betProfit({ result: 'pending', odds: 100, stake: 10 }), 0);
  close(S.betProfit({ result: 'won', odds: 120, stake: 10 }), 12);
  assert.strictEqual(S.betProfit({ result: 'lost', odds: 120, stake: 10 }), -10);
  assert.strictEqual(S.betProfit({ result: 'push', odds: 120, stake: 10 }), 0);
  assert.strictEqual(S.betProfit({ result: 'won', odds: 120, stake: 10, profitOverride: 5 }), 5);
  close(S.betProfit({ result: 'won', odds: 120, stake: 10, profitOverride: '' }), 12);
});

test('summarize computes record, win rate (pushes excluded) and ROI', () => {
  const s = S.summarize([
    { result: 'won', odds: 100, stake: 10 },
    { result: 'lost', odds: -110, stake: 11 },
    { result: 'push', odds: -110, stake: 5 },
    { result: 'pending', odds: -110, stake: 20 },
  ]);
  assert.deepStrictEqual([s.won, s.lost, s.push, s.pending, s.count], [1, 1, 1, 1, 4]);
  close(s.winRate, 0.5);
  close(s.profit, -1);
  close(s.settledStaked, 26);
  close(s.roi, -1 / 26);
  close(s.atRisk, 20);
});

test('groupStats groups by key, skipping falsy keys', () => {
  const g = S.groupStats(
    [
      { team: 'KC', result: 'won', odds: 100, stake: 1 },
      { team: 'KC', result: 'lost', odds: 100, stake: 1 },
      { team: 'BUF', result: 'won', odds: 100, stake: 1 },
      { team: '', result: 'won', odds: 100, stake: 1 },
    ],
    (b) => b.team
  );
  assert.deepStrictEqual(g.map((x) => [x.key, x.count]), [['KC', 2], ['BUF', 1]]);
  close(g[0].winRate, 0.5);
});

test('cumulative and streak follow date order', () => {
  const bets = [
    { date: '2026-01-03', result: 'won', odds: 100, stake: 10 },
    { date: '2026-01-01', result: 'lost', odds: 100, stake: 10 },
    { date: '2026-01-02', result: 'won', odds: 100, stake: 10 },
    { date: '2026-01-04', result: 'pending', odds: 100, stake: 10 },
  ];
  assert.deepStrictEqual(S.cumulative(bets).map((p) => p.total), [-10, 0, 10]);
  assert.deepStrictEqual(S.streak(bets), { type: 'won', length: 2 });
});
