'use strict';

// Installs the packages in package.json when they're missing or the wrong version.
// One-click updates copy the code but not node_modules, so the launcher (start.js) checks
// before every start, and the server checks too in case an older launcher started it.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];

function staleDependencies(appDir = APP_DIR) {
  let deps;
  try {
    deps = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).dependencies || {};
  } catch {
    return [];
  }
  return Object.entries(deps)
    .filter(([name, version]) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', name, 'package.json'), 'utf8')).version !== version;
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

// npm_execpath is set when we were started by `npm start`; otherwise fall back to `npm` on the PATH.
function npmCommand() {
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli)) return { cmd: process.execPath, args: [cli, ...ARGS], shell: false };
  return { cmd: 'npm', args: ARGS, shell: process.platform === 'win32' };
}

function installSync(appDir = APP_DIR) {
  const stale = staleDependencies(appDir);
  if (!stale.length) return true;
  console.log(`Installing ${stale.join(', ')} (one time, takes a few seconds)…`);
  const { cmd, args, shell } = npmCommand();
  const r = spawnSync(cmd, args, { cwd: appDir, stdio: 'inherit', shell });
  if (r.status !== 0) console.log("\nCouldn't install them (are you online?). BetsFriend still works; reading slips with Claude won't until the next start.\n");
  return r.status === 0;
}

function installInBackground(appDir = APP_DIR) {
  const stale = staleDependencies(appDir);
  if (!stale.length) return Promise.resolve(true);
  console.log(`Installing ${stale.join(', ')} in the background…`);
  const { cmd, args, shell } = npmCommand();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: appDir, stdio: 'ignore', shell });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      console.log(code === 0 ? `Installed ${stale.join(', ')}.` : `Couldn't install ${stale.join(', ')}; reading slips with Claude won't work until the next start.`);
      resolve(code === 0);
    });
  });
}

module.exports = { staleDependencies, installSync, installInBackground };
