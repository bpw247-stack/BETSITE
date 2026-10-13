'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../lib/niche');

test('kickoff slots use US Eastern time', () => {
  // MNF 8:15 PM ET on Monday Oct 13 2025 = 00:15Z Tuesday
  assert.deepStrictEqual(N.nflSlots('2025-10-14T00:15Z'), { primetime: true, mnf: true, tnf: false, snf: false });
  // SNF 8:20 PM ET Sunday
  assert.deepStrictEqual(N.nflSlots('2025-10-13T00:20Z'), { primetime: true, mnf: false, tnf: false, snf: true });
  // Sunday 1 PM ET
  assert.deepStrictEqual(N.nflSlots('2025-10-12T17:00Z'), { primetime: false, mnf: false, tnf: false, snf: false });
  // Thanksgiving afternoon is Thursday but not TNF
  assert.strictEqual(N.nflSlots('2025-11-27T17:30Z').tnf, false);
  assert.strictEqual(N.nflSlots('2025-11-28T01:20Z').tnf, true);
});

const ev = (id, date, home, opp, ts, os, extra = {}) => ({
  id, date, seasonType: { type: extra.post ? 3 : 2 },
  competitions: [{
    status: { type: { completed: extra.completed !== false } },
    broadcasts: extra.national ? [{ market: { type: 'National' } }] : [],
    competitors: [
      { homeAway: home ? 'home' : 'away', team: { abbreviation: 'KC' }, score: { value: ts, displayValue: String(ts) } },
      { homeAway: home ? 'away' : 'home', team: { abbreviation: opp }, score: String(os) },
    ],
  }],
});

const schedule = {
  events: [
    ev('1', '2025-09-08T00:20Z', true, 'LAC', 27, 20),   // SNF win, division
    ev('2', '2025-09-16T00:15Z', false, 'BUF', 17, 24),  // MNF loss
    ev('3', '2025-09-21T17:00Z', true, 'DEN', 30, 10),   // 1 PM win after loss, division
    ev('4', '2025-09-26T00:15Z', false, 'CIN', 20, 20),  // TNF tie
    ev('5', '2025-10-05T17:00Z', true, 'NYJ', 0, 0, { completed: false }), // not played -> skipped
    ev('6', '2026-01-18T01:00Z', true, 'HOU', 31, 14, { post: true }),
  ],
};

test('gamesFromSchedule + situationalSplits', () => {
  const games = N.gamesFromSchedule(schedule, 'KC');
  assert.strictEqual(games.length, 5);
  assert.deepStrictEqual(games[1], { id: '2', date: '2025-09-16T00:15Z', home: false, opp: 'BUF', teamScore: 17, oppScore: 24, result: 'L', postseason: false, nationalTv: false });
  const s = Object.fromEntries(N.situationalSplits(games, 'nfl', 'KC').map((x) => [x.key, [x.w, x.l, x.t]]));
  assert.deepStrictEqual(s.overall, [3, 1, 1]);
  assert.deepStrictEqual(s.mnf, [0, 1, 0]);
  assert.deepStrictEqual(s.snf, [1, 0, 0]);
  assert.deepStrictEqual(s.tnf, [0, 0, 1]);
  assert.deepStrictEqual(s.primetime, [2, 1, 1]); // SNF, MNF, TNF + playoff night game
  assert.deepStrictEqual(s.division, [2, 0, 0]);
  assert.deepStrictEqual(s.afterLoss, [1, 0, 0]);
  assert.deepStrictEqual(s.playoffs, [1, 0, 0]);
  assert.deepStrictEqual(s.home, [3, 0, 0]);
});

test('parseGameLine handles details, pick-em and spread+favorite flags', () => {
  assert.deepStrictEqual(N.parseGameLine({ pickcenter: [{ details: 'KC -3.5', overUnder: 47.5 }] }), { favorite: 'KC', spread: -3.5, overUnder: 47.5 });
  assert.deepStrictEqual(N.parseGameLine({ pickcenter: [{ details: 'EVEN', overUnder: 44 }] }), { favorite: null, spread: 0, overUnder: 44 });
  const viaFlags = N.parseGameLine({
    header: { competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: 'BUF' } }, { homeAway: 'away', team: { abbreviation: 'KC' } }] }] },
    pickcenter: [{ spread: 2.5, overUnder: '51', homeTeamOdds: { favorite: false }, awayTeamOdds: { favorite: true } }],
  });
  assert.deepStrictEqual(viaFlags, { favorite: 'KC', spread: -2.5, overUnder: 51 });
  assert.strictEqual(N.parseGameLine({}), null);
});

test('atsSplits computes covers, favorite/underdog and over/under', () => {
  const games = [
    { date: '2025-09-08T00:20Z', home: true, teamScore: 27, oppScore: 20, line: { favorite: 'KC', spread: -3.5, overUnder: 45 } }, // cover, over
    { date: '2025-09-15T00:15Z', home: false, teamScore: 17, oppScore: 24, line: { favorite: 'BUF', spread: -7, overUnder: 41 } }, // push as dog, push total
    { date: '2025-09-21T17:00Z', home: true, teamScore: 30, oppScore: 27, line: { favorite: 'KC', spread: -6, overUnder: 50 } }, // no cover, over
    { date: '2025-09-28T17:00Z', home: false, teamScore: 10, oppScore: 13, line: { favorite: 'LV', spread: -1, overUnder: 40 } }, // dog loses by 3 -> no cover, under
    { date: '2025-10-05T17:00Z', home: true, teamScore: 20, oppScore: 17, line: null },
  ];
  const r = N.atsSplits(games, 'nfl', 'KC');
  const a = Object.fromEntries(r.ats.map((x) => [x.key, [x.w, x.l, x.p]]));
  assert.deepStrictEqual(a.overall, [1, 2, 1]);
  assert.deepStrictEqual(a.fav, [1, 1, 0]);
  assert.deepStrictEqual(a.dog, [0, 1, 1]);
  assert.deepStrictEqual(a.primetime, [1, 0, 1]);
  assert.deepStrictEqual([r.ou.over, r.ou.under, r.ou.push], [2, 1, 1]);
  assert.strictEqual(r.gamesWithLine, 4);
});

test('nicheSeasons and head coach parsing', () => {
  assert.deepStrictEqual(N.nicheSeasons('nfl', new Date('2026-10-12T00:00Z')), [2023, 2024, 2025, 2026]);
  assert.deepStrictEqual(N.nicheSeasons('nba', new Date('2026-10-12T00:00Z')), [2026, 2027]);
  assert.deepStrictEqual(N.headCoachFromRoster({ coach: [{ firstName: 'Andy', lastName: 'Reid', experience: 28 }] }), { name: 'Andy Reid', experience: 28 });
  assert.strictEqual(N.headCoachFromRoster({}), null);
  assert.strictEqual(N.divisionOf('nfl', 'KC'), 'AFC West');
});

test('atsSplits reports current ATS / O-U streaks and night-game ATS', () => {
  const mk = (date, ts, os, spread, ou) => ({ date, home: true, teamScore: ts, oppScore: os, line: { favorite: 'KC', spread, overUnder: ou } });
  const games = [
    mk('2025-09-08T00:20Z', 10, 20, -3, 40), // L, under
    mk('2025-09-21T17:00Z', 27, 20, -3, 40), // W, over
    mk('2025-09-28T17:00Z', 24, 21, -3, 50), // P (push), under
    mk('2025-10-06T00:20Z', 30, 10, -7, 44), // W (SNF), under
  ];
  const r = N.atsSplits(games, 'nfl', 'KC');
  assert.deepStrictEqual(r.atsStreak, { type: 'W', length: 2 });
  assert.deepStrictEqual(r.ouStreak, { type: 'U', length: 2 });
  const snf = r.ats.find((x) => x.key === 'snf');
  assert.deepStrictEqual([snf.w, snf.l], [1, 1]);
  assert.ok(!r.ats.find((x) => x.key === 'mnf')); // no MNF games -> row omitted
});
