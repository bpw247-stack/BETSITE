'use strict';

// Self-updater: compares the installed version (data/version.json) with the newest commit
// on GitHub and installs a new version from GitHub's source ZIP. The data/ folder (bets,
// notes, backups, version file) is never touched, and db.json is backed up first.

const fs = require('fs');
const path = require('path');
const { unzip } = require('./unzip');

const REPO = 'bpw247-stack/BETSITE';
const BRANCH = 'claude/sports-betting-tracker-ue9ixp';
const REQUIRED_FILES = ['server.js', 'package.json', 'public/index.html', 'public/app.js'];
const KEEP_BACKUPS = 10;

function createUpdater({ appDir, dataDir, repo = REPO, branch = BRANCH, fetchImpl = (...a) => fetch(...a) }) {
  const versionFile = path.join(dataDir, 'version.json');
  const headers = { 'User-Agent': 'BetSite-Updater', Accept: 'application/vnd.github+json' };

  function installed() {
    try {
      const v = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return v && v.sha ? v : null;
    } catch {
      return null;
    }
  }

  async function github(url) {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    if (r.status === 404) throw new Error("Couldn't find BetSite on GitHub. Is the repository set to public?");
    if (r.status === 403 || r.status === 429) throw new Error('GitHub is limiting requests right now. Try again in an hour.');
    if (!r.ok) throw new Error(`GitHub responded ${r.status}`);
    return r;
  }

  async function check() {
    const r = await github(`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=20`);
    const commits = (await r.json()) || [];
    if (!commits.length) throw new Error('No versions found on GitHub');
    const cur = installed();
    const changes = [];
    for (const c of commits) {
      if (cur && c.sha === cur.sha) break;
      changes.push({
        sha: c.sha,
        message: String((c.commit && c.commit.message) || '').split('\n')[0],
        date: (c.commit && c.commit.author && c.commit.author.date) || '',
      });
    }
    return {
      installed: cur ? cur.sha : null,
      installedAt: cur ? cur.installedAt : null,
      latest: commits[0].sha,
      latestDate: (commits[0].commit && commits[0].commit.author && commits[0].commit.author.date) || '',
      upToDate: !!cur && cur.sha === commits[0].sha,
      unknown: !cur,
      changes: cur ? changes : changes.slice(0, 5),
      checkedAt: new Date().toISOString(),
    };
  }

  function backupData() {
    const db = path.join(dataDir, 'db.json');
    if (!fs.existsSync(db)) return null;
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(db, file);
    const old = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(dir, f));
    return file;
  }

  async function apply(sha) {
    if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('Invalid version id');
    const r = await github(`https://api.github.com/repos/${repo}/zipball/${sha}`);
    const entries = unzip(Buffer.from(await r.arrayBuffer()));

    // GitHub wraps everything in one top-level folder; strip it and keep only safe app paths.
    const files = [];
    for (const e of entries) {
      const rel = e.name.split('/').slice(1).join('/');
      if (!rel || rel.startsWith('data/') || rel === 'data') continue;
      const dest = path.resolve(appDir, rel);
      if (!dest.startsWith(path.resolve(appDir) + path.sep)) continue; // no escaping the app folder
      files.push({ rel, dest, data: e.data });
    }
    const names = new Set(files.map((f) => f.rel));
    const missing = REQUIRED_FILES.filter((f) => !names.has(f));
    if (missing.length) throw new Error(`Download looks incomplete (missing ${missing.join(', ')}); nothing was changed.`);

    const backup = backupData();

    // Stage everything first so a failure part-way leaves the current version intact.
    fs.mkdirSync(dataDir, { recursive: true });
    const staging = fs.mkdtempSync(path.join(dataDir, '.update-'));
    try {
      for (const f of files) {
        const tmp = path.join(staging, f.rel);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, f.data);
      }
      for (const f of files) {
        fs.mkdirSync(path.dirname(f.dest), { recursive: true });
        fs.copyFileSync(path.join(staging, f.rel), f.dest);
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(versionFile, JSON.stringify({ sha, installedAt: new Date().toISOString() }, null, 2));
    return { sha, files: files.length, backup };
  }

  return { installed, check, apply };
}

module.exports = { createUpdater, REPO, BRANCH };
