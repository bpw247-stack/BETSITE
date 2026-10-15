'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { advise } = require('../lib/advisor');

const matchup = (margin, total, edges = { DEN: 4, SEA: 1 }) => ({ onPaper: { DEN: (total + margin) / 2, SEA: (total - margin) / 2, total, margin }, edges });
const game = { sport: 'NFL', home: 'SEA', away: 'DEN', homeSpread: -2.5, total: 40.5 };

test('suggests the spread side the numbers favor, with reasons for and against', () => {
  // DEN (away, +2.5) wins by 4 on paper
  const out = advise({ game, matchup: matchup(4, 44), trends: [{ team: 'DEN', opp: 'SEA', text: 'has covered 5 straight', score: 6, suggest: { betType: 'Spread', side: 'team' } }] });
  const sp = out.find((x) => x.betType === 'Spread');
  assert.strictEqual(sp.pick.team, 'DEN');
  assert.strictEqual(sp.pick.line, 2.5);
  assert.ok(sp.for.some((r) => r.source === 'Rankings'));
  assert.ok(sp.for.some((r) => r.source === 'Trends'));
  // the dog wins on paper -> moneyline value too
  const ml = out.find((x) => x.betType === 'Moneyline');
  assert.strictEqual(ml.pick.team, 'DEN');
});

test('totals use on-paper scoring, weather and QB injuries', () => {
  const out = advise({ game, matchup: matchup(0, 36), weather: { wind: 22, gust: 31 }, injuries: { SEA: [{ name: 'Sam Darnold', position: 'QB', status: 'Out' }] } });
  const t = out.find((x) => x.betType === 'Total');
  assert.strictEqual(t.pick.side, 'Under');
  assert.deepStrictEqual(t.for.map((r) => r.source).sort(), ['Injuries', 'Rankings', 'Weather']);
  assert.strictEqual(t.confidence, 'Strong');
  // and the SEA spread is hurt by its QB being out
  const sp = advise({ game, matchup: matchup(-6, 44), injuries: { SEA: [{ name: 'Sam Darnold', position: 'QB', status: 'Out' }] } }).find((x) => x.betType === 'Spread');
  assert.ok(!sp || sp.pick.team === 'DEN' || sp.against.some((r) => r.source === 'Injuries'));
});

test("the user's own record counts: a bad history with a team argues against it", () => {
  const bets = Array.from({ length: 8 }, (_, i) => ({ sport: 'NFL', betType: 'Spread', team: 'DEN', opponent: 'KC', result: i < 2 ? 'won' : 'lost' }));
  const out = advise({ game, matchup: matchup(4, 44), bets });
  const sp = out.find((x) => x.betType === 'Spread' && x.pick.team === 'DEN');
  assert.ok(sp.against.some((r) => r.source === 'Your record' && /2-6 betting on DEN/.test(r.text)));
});

test('player props: matchup verdict picks the side; nothing is suggested without an edge', () => {
  const props = [{ player: 'Bo Nix', category: 'Rushing Yards', line: 32.5, over: { price: -110, book: 'DK' }, under: { price: -110, book: 'FD' }, team: 'DEN', opp: 'SEA', qb: true }];
  const good = advise({ game, props, propNotes: (p) => ({ score: p.side === 'Over' ? 0.6 : -0.6, verdict: p.side === 'Over' ? 'favorable' : 'tough', factors: [{ impact: 'major', lean: 1, rank: 32, label: 'QB rush yards allowed' }] }) });
  const prop = good.find((x) => x.betType === 'Player Prop');
  assert.strictEqual(prop.pick.side, 'Over');
  assert.match(prop.for[0].text, /SEA ranks 32nd in qb rush yards allowed/);
  const none = advise({ game, props, propNotes: () => ({ score: 0.02, verdict: 'mixed', factors: [] }) });
  assert.ok(!none.some((x) => x.betType === 'Player Prop'));
});
