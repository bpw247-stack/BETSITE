'use strict';

// Launcher used by `npm start`. Runs server.js and starts it again whenever it exits with
// RESTART_CODE, which is how the in-app updater switches to a freshly installed version.
// Control+C stops both.

const { spawn } = require('child_process');
const path = require('path');

const RESTART_CODE = 75;

function run() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, BETSITE_LAUNCHER: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE) {
      console.log('\n↻ Restarting BetSite with the new version…\n');
      return run();
    }
    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
}

run();
