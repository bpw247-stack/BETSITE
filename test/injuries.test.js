'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEspnInjuries } = require('../lib/injuries');

test('parses ESPN injuries payload', () => {
  const teams = parseEspnInjuries({
    injuries: [
      {
        id: '12',
        displayName: 'Kansas City Chiefs',
        injuries: [
          {
            status: 'Questionable',
            date: '2026-10-10T18:00Z',
            shortComment: 'Limited in practice.',
            longComment: 'Longer note',
            athlete: { displayName: 'Test Player', position: { abbreviation: 'WR' }, team: { abbreviation: 'KC' } },
            details: { type: 'Ankle', detail: 'Sprain', side: 'Right', returnDate: '2026-10-19' },
          },
          { status: 'Out' }, // no athlete -> dropped
        ],
      },
      { displayName: 'Arizona Cardinals', injuries: [] },
    ],
  });
  assert.strictEqual(teams.length, 2);
  assert.strictEqual(teams[0].team, 'Arizona Cardinals');
  const kc = teams[1];
  assert.strictEqual(kc.abbr, 'KC');
  assert.deepStrictEqual(kc.players, [
    { name: 'Test Player', position: 'WR', status: 'Questionable', injury: 'Right Ankle Sprain', returnDate: '2026-10-19', date: '2026-10-10T18:00Z', comment: 'Limited in practice.', detail: 'Longer note' },
  ]);
});

test('tolerates garbage input', () => {
  assert.deepStrictEqual(parseEspnInjuries(null), []);
  assert.deepStrictEqual(parseEspnInjuries({ injuries: 'x' }), []);
});
