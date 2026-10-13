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

test('parlayResult derives the overall result from legs', () => {
  const r = (...xs) => S.parlayResult(xs.map((result) => ({ result })));
  assert.strictEqual(S.parlayResult([]), null);
  assert.strictEqual(r('won', 'won'), 'won');
  assert.strictEqual(r('won', 'lost', 'pending'), 'lost');
  assert.strictEqual(r('won', 'pending'), 'pending');
  assert.strictEqual(r('won', 'push'), 'won');
  assert.strictEqual(r('push', 'push'), 'push');
});

test('parlayOdds combines leg odds; pushed legs reduce the payout', () => {
  assert.strictEqual(S.parlayOdds([{ odds: -110 }, { odds: -110 }]), 264);
  assert.strictEqual(S.parlayOdds([{ odds: -110 }, { odds: '' }]), null);
  const bet = { result: 'won', odds: 264, stake: 10, legs: [{ odds: -110, result: 'won' }, { odds: -110, result: 'push' }] };
  close(S.betProfit(bet), 10 * (100 / 110));
});

test('picks expands parlay legs; legs count for record but not money', () => {
  const parlay = {
    sport: 'NFL', date: '2026-10-01', betType: 'Parlay', odds: 264, stake: 10, result: 'lost',
    legs: [
      { betType: 'Moneyline', team: 'KC', result: 'won' },
      { betType: 'Player Prop', team: 'BUF', player: 'Josh Allen', propCategory: 'Passing Yards', result: 'lost' },
    ],
  };
  const straight = { sport: 'NFL', betType: 'Moneyline', team: 'KC', odds: 100, stake: 5, result: 'won' };
  const picks = S.picks([parlay, straight]);
  assert.strictEqual(picks.length, 3);
  assert.strictEqual(picks[0].sport, 'NFL');
  assert.strictEqual(picks[0].parlay, parlay);

  const kc = S.groupStats(picks, (p) => p.team).find((g) => g.key === 'KC');
  assert.deepStrictEqual([kc.count, kc.legs, kc.won, kc.lost], [2, 1, 2, 0]);
  close(kc.profit, 5); // only the straight bet's money
  close(kc.staked, 5);

  const props = S.groupStats(picks.filter((p) => p.propCategory), (p) => p.propCategory);
  assert.deepStrictEqual([props[0].key, props[0].lost, props[0].winRate], ['Passing Yards', 1, 0]);
});

test('kellyFraction and bankrollNow', () => {
  // even money, 55% -> (1*0.55 - 0.45)/1 = 0.10
  close(S.kellyFraction(100, 0.55), 0.1);
  assert.strictEqual(S.kellyFraction(-110, 0.5), 0); // no edge
  assert.strictEqual(S.kellyFraction(-110, 1.5), 0); // nonsense probability
  const bets = [
    { date: '2026-10-01', result: 'won', odds: 100, stake: 50 },
    { date: '2026-09-01', result: 'lost', odds: 100, stake: 50 }, // before start date
    { date: '2026-10-02', result: 'lost', odds: 100, stake: 20 },
  ];
  assert.strictEqual(S.bankrollNow({ bankroll: 1000, bankrollDate: '2026-09-15' }, bets), 1030);
  assert.strictEqual(S.bankrollNow({ bankroll: 1000, trackProfit: false }, bets), 1000);
  assert.strictEqual(S.bankrollNow({}, bets), null);
});

test('takeaways ranks by edge and sample size; oddsBucket', () => {
  const g = (key, won, lost) => ({ key, won, lost, winRate: won / (won + lost) });
  const t = S.takeaways([g('big sample', 12, 3), g('tiny', 2, 0), g('cold', 4, 11), g('meh', 5, 5)]);
  assert.deepStrictEqual(t.strengths.map((x) => x.key), ['big sample']);
  assert.deepStrictEqual(t.weaknesses.map((x) => x.key), ['cold']);
  assert.strictEqual(S.oddsBucket(-250), 'Heavy favorite (-200 or shorter)');
  assert.strictEqual(S.oddsBucket(-110), 'Favorite (-199 to -101)');
  assert.strictEqual(S.oddsBucket(120), 'Near even (-100 to +150)');
  assert.strictEqual(S.oddsBucket(450), 'Long shot (+301 or longer)');
  assert.strictEqual(S.oddsBucket(''), null);
});
