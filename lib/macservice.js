'use strict';

// "Run in the background" on a Mac: a per-user launchd agent that starts BetsFriend at login
// and restarts it if it stops, so the app icon always opens a working BetsFriend.
// Nothing needs admin rights; everything lives in ~/Library/LaunchAgents and the data folder.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LABEL = 'com.betsfriend.server';

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function paths({ home = os.homedir(), dataDir }) {
  return {
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: path.join(dataDir, 'logs', 'betsfriend.log'),
  };
}

// launchd starts programs with a bare PATH; include node's folder so npm (and node) are found.
function plistXml({ nodePath, appDir, log, env = {} }) {
  const pathVar = [path.dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((v, i, a) => a.indexOf(v) === i).join(':');
  const vars = { PATH: pathVar, BETSFRIEND_SERVICE: '1', ...env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(path.join(appDir, 'start.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(appDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function createMacService({ appDir, dataDir, nodePath = process.execPath, home = os.homedir(), uid = process.getuid ? process.getuid() : 0, platform = process.platform, spawnDetached = defaultSpawn }) {
  const p = paths({ home, dataDir });
  const target = `gui/${uid}/${LABEL}`;
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const mustBeMac = () => {
    if (platform !== 'darwin') throw Object.assign(new Error('Running in the background is set up for Macs only.'), { status: 400 });
  };

  return {
    supported: platform === 'darwin',
    paths: p,
    status() {
      return { supported: platform === 'darwin', installed: fs.existsSync(p.plist), runningAsService: process.env.BETSFRIEND_SERVICE === '1', log: p.log };
    },
    // Writes the agent, then (a second later, from a separate process so it survives this one
    // being replaced) asks launchd to load it. The caller should exit so the background copy
    // can take over the port; the server retries the port until it's free.
    install(env = {}) {
      mustBeMac();
      fs.mkdirSync(path.dirname(p.plist), { recursive: true });
      fs.mkdirSync(path.dirname(p.log), { recursive: true });
      fs.writeFileSync(p.plist, plistXml({ nodePath, appDir, log: p.log, env }));
      spawnDetached(`sleep 1; launchctl bootout ${q(target)} 2>/dev/null; launchctl bootstrap ${q(`gui/${uid}`)} ${q(p.plist)} || launchctl load -w ${q(p.plist)}`);
      return { ...this.status(), installed: true };
    },
    // Removes the agent; launchd then stops the background copy (possibly this process).
    uninstall() {
      mustBeMac();
      const existed = fs.existsSync(p.plist);
      if (existed) fs.unlinkSync(p.plist);
      spawnDetached(`sleep 1; launchctl bootout ${q(target)} 2>/dev/null || true`);
      return { ...this.status(), installed: false, existed };
    },
  };
}

function defaultSpawn(script) {
  const { spawn } = require('child_process');
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { createMacService, plistXml, LABEL };
