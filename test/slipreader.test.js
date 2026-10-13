'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readSlip, toParsed, slipSchema, loadCatalog, MODEL } = require('../lib/slipreader');

const catalog = loadCatalog();
const PNG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

function fakeClient(answer, extra = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }], ...extra };
        },
      },
    },
  };
}

const parlay = {
  is_bet_slip: true, book: 'DraftKings', bet_type: 'Parlay', stake: 10, to_win: 59.6, odds: 596, date: '2026-10-18', notes: null,
  legs: [
    { sport: 'NFL', bet_type: 'Spread', team: 'DET', opponent: 'DAL', player: null, prop_category: null, side: null, line: -2.5, odds: -110 },
    { sport: 'NBA', bet_type: 'Player Prop', team: null, opponent: null, player: 'Nikola Jokic', prop_category: 'Pts + Reb + Ast', side: 'Under', line: 48.5, odds: -115 },
  ],
};

test('sends the screenshots with a structured-output schema and maps the answer to the slip shape', async () => {
  const client = fakeClient(parlay);
  const p = await readSlip({ images: [PNG], client, catalog, today: '2026-10-18' });
  const req = client.calls[0];
  assert.strictEqual(req.model, MODEL);
  assert.strictEqual(req.fallbacks, 'default');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.match(req.system, /2026-10-18/);
  assert.deepStrictEqual(req.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.data } });

  assert.strictEqual(p.betType, 'Parlay');
  assert.strictEqual(p.book, 'DraftKings');
  assert.deepStrictEqual([p.stake, p.toWin, p.odds, p.date], [10, 59.6, 596, '2026-10-18']);
  assert.deepStrictEqual(p.legs[0], { betType: 'Spread', sport: 'NFL', team: 'DET', opponent: 'DAL', line: -2.5, odds: -110 });
  assert.strictEqual(p.legs[1].player, 'Nikola Jokic');
  assert.ok(p.warnings.some((w) => /player's team/.test(w)));
});

test('drops team abbreviations that are not in that sport and odds that are not American', () => {
  const p = toParsed({ ...parlay, odds: 5, legs: [{ ...parlay.legs[0], team: 'LAL', opponent: 'XYZ', odds: 1 }] }, catalog);
  assert.strictEqual(p.legs[0].team, undefined);
  assert.strictEqual(p.legs[0].opponent, undefined);
  assert.strictEqual(p.legs[0].odds, undefined);
  assert.strictEqual(p.odds, undefined);
  assert.ok(p.warnings.includes('No odds found.'));
});

test('a picture that is not a bet slip comes back with a warning and no legs', () => {
  const p = toParsed({ is_bet_slip: false, legs: [] }, catalog);
  assert.deepStrictEqual(p.legs, []);
  assert.match(p.warnings[0], /doesn't look like a bet slip/);
});

test('refusals and bad input give readable errors', async () => {
  await assert.rejects(readSlip({ images: [PNG], client: fakeClient(parlay, { stop_reason: 'refusal', content: [] }), catalog }), /couldn't read this image/);
  await assert.rejects(readSlip({ images: [], client: fakeClient(parlay), catalog }), /Add a screenshot/);
  await assert.rejects(readSlip({ images: [{ mediaType: 'application/pdf', data: 'AAAA' }], client: fakeClient(parlay), catalog }), /JPEG, PNG/);
  await assert.rejects(readSlip({ images: Array(5).fill(PNG), client: fakeClient(parlay), catalog }), /at most 4/);
});

test('schema only uses features structured outputs supports', () => {
  const json = JSON.stringify(slipSchema(catalog));
  assert.doesNotMatch(json, /"(minimum|maximum|minLength|maxLength|multipleOf)"/);
  const objects = [];
  (function walk(n) {
    if (n && typeof n === 'object') {
      if (n.type === 'object') objects.push(n);
      Object.values(n).forEach(walk);
    }
  })(slipSchema(catalog));
  assert.ok(objects.length >= 2 && objects.every((o) => o.additionalProperties === false && o.required.length === Object.keys(o.properties).length));
});
