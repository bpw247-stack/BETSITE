'use strict';

// Turn "run in the background" on or off from Terminal (the same switch as Settings → Desktop app):
//   npm run background        start BetsFriend at login and keep it running
//   npm run background:off    stop doing that

const path = require('path');
const { createMacService } = require('../lib/macservice');

const appDir = path.join(__dirname, '..');
const dataFile = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(appDir, 'data', 'db.json');
const svc = createMacService({ appDir, dataDir: path.dirname(dataFile) });
const port = process.env.PORT || 3000;

try {
  if (process.argv[2] === 'off') {
    const st = svc.uninstall();
    console.log(st.existed ? 'BetsFriend no longer runs in the background. Start it with: npm start' : "BetsFriend wasn't running in the background.");
  } else {
    const env = Object.fromEntries([['DATA_FILE', process.env.DATA_FILE && dataFile], ['PORT', process.env.PORT], ['HOST', process.env.HOST]].filter(([, v]) => v));
    svc.install(env);
    console.log(`BetsFriend now runs in the background and starts when you log in.\nOpen http://localhost:${port} (or the BetsFriend app). Log: ${svc.paths.log}`);
    console.log('If BetsFriend is also running in a Terminal window, press Control + C there; the background copy takes over.');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
