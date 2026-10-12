'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { unzip } = require('../lib/unzip');
const { createUpdater } = require('../lib/updater');

// Build a ZIP (deflate entries) the same shape GitHub's zipball has.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(content);
    const comp = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const SHA_NEW = 'a'.repeat(40);
const SHA_MID = 'b'.repeat(40);
const SHA_OLD = 'c'.repeat(40);

function fakeGitHub(zip) {
  return async (url) => {
    if (url.includes('/commits?')) {
      return Response.json([
        { sha: SHA_NEW, commit: { message: 'Add cool feature\n\nbody', author: { date: '2026-10-12T20:00:00Z' } } },
        { sha: SHA_MID, commit: { message: 'Fix a bug', author: { date: '2026-10-11T20:00:00Z' } } },
        { sha: SHA_OLD, commit: { message: 'First version', author: { date: '2026-10-10T20:00:00Z' } } },
      ]);
    }
    if (url.includes('/zipball/')) return new Response(zip);
    return new Response('nope', { status: 404 });
  };
}

function setup(zipFiles) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-app-'));
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(appDir, 'server.js'), 'old server');
  fs.writeFileSync(path.join(dataDir, 'db.json'), '{"bets":[{"id":"1"}]}');
  const zip = makeZip(zipFiles);
  return { appDir, dataDir, updater: createUpdater({ appDir, dataDir, fetchImpl: fakeGitHub(zip) }) };
}

const GOOD = {
  'owner-BETSITE-aaaaaaa/server.js': 'new server',
  'owner-BETSITE-aaaaaaa/package.json': '{}',
  'owner-BETSITE-aaaaaaa/public/index.html': '<html>',
  'owner-BETSITE-aaaaaaa/public/app.js': 'app',
  'owner-BETSITE-aaaaaaa/data/db.json': '{"bets":[]}',
  'owner-BETSITE-aaaaaaa/../escape.txt': 'nope',
};

test('unzip reads deflated entries', () => {
  const files = unzip(makeZip({ 'x/a.txt': 'hello', 'x/b/c.txt': 'world' }));
  assert.deepStrictEqual(files.map((f) => [f.name, f.data.toString()]), [['x/a.txt', 'hello'], ['x/b/c.txt', 'world']]);
  assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /Not a ZIP/);
});

test('check reports unknown, then lists changes since the installed version', async () => {
  const { dataDir, updater } = setup(GOOD);
  let c = await updater.check();
  assert.strictEqual(c.unknown, true);
  assert.strictEqual(c.upToDate, false);
  assert.strictEqual(c.latest, SHA_NEW);

  fs.writeFileSync(path.join(dataDir, 'version.json'), JSON.stringify({ sha: SHA_OLD }));
  c = await updater.check();
  assert.strictEqual(c.unknown, false);
  assert.deepStrictEqual(c.changes.map((x) => x.message), ['Add cool feature', 'Fix a bug']);

  fs.writeFileSync(path.join(dataDir, 'version.json'), JSON.stringify({ sha: SHA_NEW }));
  c = await updater.check();
  assert.strictEqual(c.upToDate, true);
  assert.strictEqual(c.changes.length, 0);
});

test('apply installs app files, never touches data, backs up db.json and records the version', async () => {
  const { appDir, dataDir, updater } = setup(GOOD);
  const r = await updater.apply(SHA_NEW);
  assert.strictEqual(fs.readFileSync(path.join(appDir, 'server.js'), 'utf8'), 'new server');
  assert.strictEqual(fs.readFileSync(path.join(appDir, 'public/app.js'), 'utf8'), 'app');
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), '{"bets":[{"id":"1"}]}'); // untouched
  assert.ok(!fs.existsSync(path.join(path.dirname(appDir), 'escape.txt')));
  assert.ok(r.backup && fs.readFileSync(r.backup, 'utf8').includes('"id":"1"'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'version.json'), 'utf8')).sha, SHA_NEW);
  assert.deepStrictEqual(fs.readdirSync(dataDir).filter((f) => f.startsWith('.update-')), []); // staging cleaned up
});

test('apply refuses an incomplete download and changes nothing', async () => {
  const { appDir, updater } = setup({ 'x/server.js': 'broken' });
  await assert.rejects(updater.apply(SHA_NEW), /incomplete/);
  assert.strictEqual(fs.readFileSync(path.join(appDir, 'server.js'), 'utf8'), 'old server');
  await assert.rejects(updater.apply('not-a-sha'), /Invalid/);
});
