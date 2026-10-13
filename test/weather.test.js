'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/weather');

test('summarizeForecast uses the game window and flags conditions', () => {
  const hourly = {
    time: ['2026-11-15T17:00', '2026-11-15T18:00', '2026-11-15T19:00', '2026-11-15T20:00', '2026-11-15T21:00', '2026-11-15T23:00'],
    temperature_2m: [30.4, 31, 29, 28, 27, 20],
    precipitation_probability: [20, 40, 70, 60, 30, 0],
    precipitation: [0, 0, 0.05, 0.02, 0, 0],
    wind_speed_10m: [12, 14, 18, 16, 10, 40],
    wind_gusts_10m: [20, 22, 29, 25, 18, 60],
    weather_code: [3, 3, 73, 71, 3, 0],
  };
  const s = W.summarizeForecast({ hourly }, '2026-11-15T18:00:00Z');
  assert.strictEqual(s.temp, 31);
  assert.strictEqual(s.wind, 18); // 23:00 is outside the 3-hour window
  assert.strictEqual(s.gust, 29);
  assert.strictEqual(s.precipChance, 70);
  assert.strictEqual(s.condition, 'Snow');
  assert.deepStrictEqual(s.flags.map((f) => f.type), ['wind', 'snow', 'cold']);
  assert.strictEqual(W.summarizeForecast({}, '2026-11-15T18:00:00Z'), null);
  assert.ok(W.forecastUrl(W.STADIUMS.GB, '2026-11-15T18:00:00Z').includes('start_date=2026-11-15'));
  assert.strictEqual(Object.keys(W.STADIUMS).length, 32);
});
