'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacService, plistXml, LABEL } = require('../lib/macservice');

test('plist runs start.js with node, keeps it alive, logs to data/logs and escapes paths', () => {
  const x = plistXml({ nodePath: '/Users/bo/.nvm/versions/node/v22/bin/node', appDir: '/Users/bo/Bets & Stuff', log: '/Users/bo/Bets & Stuff/data/logs/betsfriend.log', env: { PORT: '3000' } });
  assert.match(x, new RegExp(`<string>${LABEL}</string>`));
  assert.match(x, /<string>\/Users\/bo\/\.nvm\/versions\/node\/v22\/bin\/node<\/string>/);
  assert.match(x, /<string>\/Users\/bo\/Bets &amp; Stuff\/start\.js<\/string>/);
  assert.match(x, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(x, /<key>KeepAlive<\/key><true\/>/);
  assert.match(x, /<key>PATH<\/key><string>\/Users\/bo\/\.nvm\/versions\/node\/v22\/bin:\/opt\/homebrew\/bin:/);
  assert.match(x, /<key>BETSFRIEND_SERVICE<\/key><string>1<\/string>/);
  assert.match(x, /<key>PORT<\/key><string>3000<\/string>/);
  assert.doesNotMatch(x, /& /);
});

test('install writes the agent and asks launchd to load it; uninstall removes it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-home-'));
  const dataDir = path.join(home, 'app', 'data');
  const scripts = [];
  const svc = createMacService({ appDir: path.join(home, 'app'), dataDir, nodePath: '/usr/local/bin/node', home, uid: 501, platform: 'darwin', spawnDetached: (s) => scripts.push(s) });
  assert.strictEqual(svc.status().installed, false);
  const st = svc.install({ PORT: '3000' });
  assert.strictEqual(st.installed, true);
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  assert.ok(fs.existsSync(plist));
  assert.ok(fs.existsSync(path.join(dataDir, 'logs')));
  assert.match(scripts[0], new RegExp(`launchctl bootout 'gui/501/${LABEL}'`));
  assert.match(scripts[0], new RegExp(`launchctl bootstrap 'gui/501' '${plist.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`));
  const un = svc.uninstall();
  assert.strictEqual(un.installed, false);
  assert.ok(!fs.existsSync(plist));
  assert.match(scripts[1], /launchctl bootout/);
});

test('refuses on computers that are not Macs', () => {
  const svc = createMacService({ appDir: '/x', dataDir: '/x/data', platform: 'win32', spawnDetached: () => assert.fail('should not run') });
  assert.strictEqual(svc.supported, false);
  assert.throws(() => svc.install(), /Macs only/);
});
