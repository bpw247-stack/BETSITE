'use strict';

// Password protection for access from other devices (phone, tablet).
// The computer running BetSite (localhost) never needs to log in. Other devices are
// blocked until a password is set, then need to sign in once (cookie lasts 90 days).
// Stored in data/auth.json: scrypt password hash + hashed session tokens.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'betsite_session';
const SESSION_DAYS = 90;

function createAuth({ dataDir }) {
  const file = path.join(dataDir, 'auth.json');
  let state = { salt: null, hash: null, sessions: {} };
  try {
    state = { sessions: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {}
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const attempts = new Map(); // ip -> [timestamps]

  return {
    passwordSet: () => !!state.hash,
    setPassword(pw) {
      if (typeof pw !== 'string' || pw.length < 6) throw Object.assign(new Error('Use at least 6 characters'), { status: 400 });
      state.salt = crypto.randomBytes(16).toString('hex');
      state.hash = crypto.scryptSync(pw, state.salt, 64).toString('hex');
      state.sessions = {}; // changing the password signs out every device
      save();
    },
    disable() {
      state = { salt: null, hash: null, sessions: {} };
      save();
    },
    verify(pw) {
      if (!state.hash || typeof pw !== 'string') return false;
      const h = crypto.scryptSync(pw, state.salt, 64);
      return crypto.timingSafeEqual(h, Buffer.from(state.hash, 'hex'));
    },
    // simple brute-force guard: 10 tries per 15 minutes per address
    allowAttempt(ip) {
      const now = Date.now();
      const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
      list.push(now);
      attempts.set(ip, list);
      return list.length <= 10;
    },
    createSession(ua) {
      const token = crypto.randomBytes(32).toString('hex');
      state.sessions[sha(token)] = { created: new Date().toISOString(), ua: String(ua || '').slice(0, 120) };
      save();
      return token;
    },
    endSession(token) {
      if (token && state.sessions[sha(token)]) {
        delete state.sessions[sha(token)];
        save();
      }
    },
    validSession(token) {
      if (!token || !state.hash) return false;
      const s = state.sessions[sha(token)];
      if (!s) return false;
      if (Date.now() - Date.parse(s.created) > SESSION_DAYS * 86400000) {
        delete state.sessions[sha(token)];
        save();
        return false;
      }
      return true;
    },
    sessionCount: () => Object.keys(state.sessions).length,
    cookieHeader: (token) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    clearCookieHeader: () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    tokenFrom(req) {
      const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
      return m ? m[1] : null;
    },
  };
}

function isLocalRequest(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light dark;--bg:#f4f4f2;--card:#fcfcfb;--text:#0b0b0b;--muted:#6b6a66;--accent:#2a78d6;--bad:#c0362f;--border:#dddcd7}
@media (prefers-color-scheme:dark){:root{--bg:#111110;--card:#1a1a19;--text:#f0efec;--muted:#8f8e86;--accent:#3987e5;--bad:#f07b72;--border:#34332f}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,sans-serif;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;max-width:380px;width:100%;box-sizing:border-box}
h1{font-size:1.35rem;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px}
input{font:inherit;width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--border);border-radius:10px;background:transparent;color:inherit;margin-bottom:12px}
button{font:inherit;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:600}
.err{color:var(--bad);margin-bottom:12px}</style></head><body><div class="card">${body}</div></body></html>`;

function loginPage(error) {
  return page('BetSite sign in', `<h1>🎯 BetSite</h1><p>Enter your BetSite password.</p>${error ? `<div class="err">${error}</div>` : ''}
<form method="post" action="/login"><input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Password"><button type="submit">Sign in</button></form>`);
}

function blockedPage() {
  return page('BetSite: phone access is off', `<h1>📱 Phone access is off</h1><p>To use BetSite on this device, go to the computer running BetSite, open <strong>Settings → Phone access</strong> and set a password. Then reload this page.</p>`);
}

module.exports = { createAuth, isLocalRequest, loginPage, blockedPage };
