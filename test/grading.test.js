'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/grading');

const nflSummary = {
  header: { competitions: [{ status: { type: { completed: true } }, competitors: [
    { homeAway: 'home', score: '27', team: { abbreviation: 'KC' } },
    { homeAway: 'away', score: '20', team: { abbreviation: 'BUF' } },
  ] }] },
  boxscore: { players: [
    { team: { abbreviation: 'KC' }, statistics: [
      { name: 'passing', labels: ['C/ATT', 'YDS', 'AVG', 'TD', 'INT', 'SACKS', 'QBR', 'RTG'], athletes: [{ athlete: { displayName: 'Patrick Mahomes' }, stats: ['25/34', '312', '9.2', '3', '1', '2-14', '70.1', '110.2'] }] },
      { name: 'rushing', labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'], athletes: [
        { athlete: { displayName: 'Patrick Mahomes' }, stats: ['4', '-3', '-0.8', '0', '2'] },
        { athlete: { displayName: 'Isiah Pacheco' }, stats: ['18', '86', '4.8', '1', '21'] },
      ] },
      { name: 'receiving', labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'], athletes: [
        { athlete: { displayName: 'Travis Kelce' }, stats: ['8', '102', '12.8', '1', '31', '10'] },
        { athlete: { displayName: 'Isiah Pacheco' }, stats: ['2', '15', '7.5', '0', '9', '3'] },
      ] },
    ] },
  ] },
};

const nbaSummary = {
  header: { competitions: [{ status: { type: { completed: true } }, competitors: [
    { homeAway: 'home', score: '112', team: { abbreviation: 'BOS' } },
    { homeAway: 'away', score: '108', team: { abbreviation: 'NY' } },
  ] }] },
  boxscore: { players: [
    { team: { abbreviation: 'BOS' }, statistics: [{ labels: ['MIN', 'FG', '3PT', 'FT', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', '+/-', 'PTS'], athletes: [
      { athlete: { displayName: 'Jayson Tatum' }, stats: ['38', '11-22', '4-9', '6-7', '1', '10', '11', '6', '1', '0', '3', '2', '+8', '32'] },
      { athlete: { displayName: 'Bench Guy' }, stats: [], didNotPlay: true },
    ] }] },
  ] },
};

test('parseBoxScore extracts scores and split stats', () => {
  const box = G.parseBoxScore(nflSummary);
  assert.strictEqual(box.completed, true);
  assert.deepStrictEqual(box.teams, { KC: 27, BUF: 20 });
  const pm = box.players['patrick mahomes'].stats;
  assert.strictEqual(pm['passing.C'], 25);
  assert.strictEqual(pm['passing.ATT'], 34);
  assert.strictEqual(pm['passing.YDS'], 312);
  assert.strictEqual(pm['rushing.YDS'], -3);
  const nba = G.parseBoxScore(nbaSummary);
  assert.strictEqual(nba.players['jayson tatum'].stats['stats.3PT'], 4);
  assert.strictEqual(nba.players['jayson tatum'].stats['stats.PTS'], 32);
  assert.ok(!nba.players['bench guy']);
});

test('gradePick: game bets', () => {
  const box = G.parseBoxScore(nflSummary);
  const g = (p) => G.gradePick(p, box, 'nfl');
  assert.strictEqual(g({ betType: 'Moneyline', team: 'KC' }).result, 'won');
  assert.strictEqual(g({ betType: 'Moneyline', team: 'BUF', opponent: 'KC' }).result, 'lost');
  assert.strictEqual(g({ betType: 'Spread', team: 'KC', line: -7 }).result, 'push');
  assert.strictEqual(g({ betType: 'Spread', team: 'BUF', line: 7.5 }).result, 'won');
  assert.strictEqual(g({ betType: 'Total', team: 'KC', side: 'Over', line: 46.5 }).result, 'won');
  assert.strictEqual(g({ betType: 'Total', team: 'KC', side: 'Under', line: 46.5 }).result, 'lost');
  assert.strictEqual(g({ betType: 'Game Prop', team: 'KC', propCategory: 'Team Total', side: 'Over', line: 27.5 }).result, 'lost');
  assert.strictEqual(g({ betType: 'Spread', team: 'KC' }).status, 'review');
  assert.strictEqual(g({ betType: 'Future', team: 'KC' }).status, 'unsupported');
  assert.strictEqual(G.gradePick({ betType: 'Moneyline', team: 'KC' }, { completed: false, teams: {}, players: {} }, 'nfl').status, 'pending');
});

test('gradePick: player props incl. combos, aliases, yes/no and DNP', () => {
  const box = G.parseBoxScore(nflSummary);
  const g = (p) => G.gradePick({ betType: 'Player Prop', team: 'KC', ...p }, box, 'nfl');
  assert.strictEqual(g({ player: 'Patrick Mahomes', propCategory: 'Passing Yards', side: 'Over', line: 275.5 }).result, 'won');
  assert.strictEqual(g({ player: 'P. Mahomes', propCategory: 'Pass Yds', side: 'Under', line: 275.5 }).result, 'lost');
  assert.strictEqual(g({ player: 'Isiah Pacheco', propCategory: 'Rush + Rec Yards', side: 'Over', line: 99.5 }).result, 'won'); // 86 + 15
  assert.strictEqual(g({ player: 'Travis Kelce', propCategory: 'Anytime TD', side: 'Yes' }).result, 'won');
  assert.strictEqual(g({ player: 'Travis Kelce', propCategory: 'Rushing Yards', side: 'Over', line: 0.5 }).result, 'lost'); // no rushing row = 0
  assert.strictEqual(g({ player: 'Patrick Mahomes', propCategory: 'Pass Completions', side: 'Over', line: 25 }).result, 'push');
  assert.strictEqual(g({ player: 'Nobody Here', propCategory: 'Receptions', side: 'Over', line: 3.5 }).status, 'review');
  assert.strictEqual(g({ player: 'Travis Kelce', propCategory: 'First TD', side: 'Yes' }).status, 'unsupported');

  const nba = G.parseBoxScore(nbaSummary);
  const n = (p) => G.gradePick({ betType: 'Player Prop', team: 'BOS', player: 'Jayson Tatum', ...p }, nba, 'nba');
  assert.strictEqual(n({ propCategory: 'Pts + Reb + Ast', side: 'Over', line: 45.5 }).result, 'won'); // 32+11+6=49
  assert.strictEqual(n({ propCategory: 'PRA', side: 'Under', line: 49.5 }).result, 'won');
  assert.strictEqual(n({ propCategory: '3-Pointers Made', side: 'Over', line: 4.5 }).result, 'lost');
  assert.strictEqual(n({ propCategory: 'Double-Double', side: 'Yes' }).result, 'won');
  assert.strictEqual(n({ propCategory: 'Triple-Double', side: 'No' }).result, 'won');
  assert.strictEqual(G.gradePick({ betType: 'Player Prop', team: 'BOS', player: 'Bench Guy', propCategory: 'Points', side: 'Over', line: 5.5 }, nba, 'nba').status, 'review');
});

test('findGameForPick picks the right game near the bet date', () => {
  const ev = (id, date, opp, final = true) => ({ id, date, competitions: [{ status: { type: { completed: final } }, competitors: [{ team: { abbreviation: 'KC' } }, { team: { abbreviation: opp } }] }] });
  const payloads = [{ events: [ev('1', '2025-10-06T00:20Z', 'JAX'), ev('2', '2025-10-12T20:25Z', 'DET'), ev('3', '2025-10-20T00:15Z', 'LV', false)] }];
  assert.strictEqual(G.findGameForPick(payloads, 'KC', null, '2025-10-10').id, '2');
  assert.strictEqual(G.findGameForPick(payloads, 'KC', 'DET', '2025-10-12').id, '2');
  assert.strictEqual(G.findGameForPick(payloads, 'KC', null, '2025-10-05').id, '1'); // Sunday-night game the day of the bet (ET)
  assert.strictEqual(G.findGameForPick(payloads, 'KC', 'LV', '2025-10-18').final, false);
  assert.strictEqual(G.findGameForPick(payloads, 'KC', 'BUF', '2025-10-10'), null);
  assert.strictEqual(G.seasonForDate('nfl', '2026-01-10'), 2025);
  assert.strictEqual(G.seasonForDate('nba', '2026-10-25'), 2027);
});

test('propResearchSummary computes hit rate, average and median', () => {
  const games = [{ value: 300 }, { value: 250 }, { value: null, dnp: true }, { value: 275.5 }, { value: 310 }];
  const s = G.propResearchSummary(games, 275.5, 'Over');
  assert.deepStrictEqual([s.n, s.hits, s.misses, s.pushes], [4, 2, 1, 1]);
  assert.strictEqual(s.avg, 283.9);
  assert.strictEqual(s.median, 287.75);
  assert.deepStrictEqual([s.high, s.low], [310, 250]);
  assert.strictEqual(games[0].result, 'won');
  const u = G.propResearchSummary([{ value: 3 }, { value: 7 }], 5.5, 'Under');
  assert.deepStrictEqual([u.hits, u.misses], [1, 1]);
});

test('findPlayer: last-name fallback never matches a different first name', () => {
  const box = { players: { 'truman jones': { name: 'Truman Jones', team: 'IND', stats: {} }, 'patrick mahomes': { name: 'Patrick Mahomes', team: 'KC', stats: {} } } };
  assert.strictEqual(G.findPlayer(box, 'Daniel Jones', 'IND'), null);
  assert.strictEqual(G.findPlayer(box, 'D. Jones', 'IND'), null);
  assert.strictEqual(G.findPlayer(box, 'T. Jones', 'IND').name, 'Truman Jones');
  assert.strictEqual(G.findPlayer(box, 'Mahomes', 'KC').name, 'Patrick Mahomes');
  assert.strictEqual(G.findPlayer(box, 'P Mahomes').name, 'Patrick Mahomes');
});
