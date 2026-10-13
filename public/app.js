/* BetsFriend frontend — vanilla JS single-page app with hash routing. */
(function () {
  'use strict';

  const S = window.BetStats;
  const app = document.getElementById('app');
  const modal = document.getElementById('modal');
  const modalForm = document.getElementById('modalForm');
  const tooltip = document.getElementById('tooltip');

  const state = {
    bets: [],
    notes: [],
    teamNotes: [],
    injuries: {}, // league -> { loading, data, error }
    schedule: {}, // `${league}:${days}` -> { loading, data, error }
    h2h: {}, // `${league}:${a}:${b}` -> { loading, data, error }
    h2hOpen: new Set(), // keys of expanded "previous matchups" panels
    niche: {}, // `${league}:${a}:${b}` -> { loading, data, error }
    weather: {}, // `${home}|${kickoff}|${neutral}|${indoor}` -> forecast
    market: {}, // `${league}:${days}` -> { loading, data, error }
    props: {}, // `${league}:${gameId}` -> { loading, data, error }
    trends: {}, // `${league}:${days}` -> last /api/trends response
    rankings: null, // last /api/rankings/nfl response
    coaches: [], // coaching staffs you've entered, keyed "SPORT-ABBR"
    sort: { key: 'date', dir: -1 },
  };

  // ---------- utils ----------

  const esc = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const today = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  function money(n, signed) {
    const v = Number(n) || 0;
    const s = '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!signed) return (v < 0 ? '-' : '') + s;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
  }
  const plClass = (n) => (n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : '');
  const plHtml = (n) => `<span class="${plClass(n)}">${money(n, true)}</span>`;
  const pct = (r) => (r == null ? '—' : (r * 100).toFixed(1) + '%');
  const roiHtml = (r) => (r == null ? '<span class="muted">—</span>' : `<span class="${plClass(r)}">${r > 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span>`);
  const oddsStr = (o) => {
    const n = Number(o);
    if (!isFinite(n) || o === '' || o == null) return '—';
    return n > 0 ? '+' + n : String(n);
  };
  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d.length === 10 ? d + 'T12:00:00' : d);
    if (isNaN(dt)) return esc(d);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(d) {
    const dt = new Date(d);
    if (isNaN(dt)) return '';
    return dt.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const record = (s) => `${s.won}-${s.lost}${s.push ? '-' + s.push : ''}`;
  const badge = (result) => `<span class="badge ${esc(result || 'pending')}">${esc((result || 'pending').replace(/^./, (c) => c.toUpperCase()))}</span>`;
  const meter = (rate) =>
    rate == null
      ? '<span class="muted">—</span>'
      : `<div class="meter" title="${pct(rate)} win rate"><div class="bar"><div class="fill" style="width:${(rate * 100).toFixed(1)}%"></div></div><span class="pct">${pct(rate)}</span></div>`;

  // ---- bankroll & bet sizing ----
  const sizing = () => {
    const s = state.settings || {};
    const bankroll = S.bankrollNow(s, state.bets);
    if (bankroll == null) return null;
    const unitPct = Number(s.unitPct) || 1;
    return { bankroll, unitPct, unit: Math.max(0, bankroll * unitPct / 100), maxPct: Number(s.maxPct) || 5 };
  };
  async function saveSettings(patch) {
    state.settings = await api('PUT', '/api/settings/app', { ...state.settings, ...patch });
  }

  function teamName(sport, abbr) {
    const t = (window.LEAGUES[sport] || []).find(([a]) => a === abbr);
    return t ? t[1] : abbr || '';
  }
  const teamKey = (b) => (b.team ? `${b.sport}|${b.team}` : null);
  const teamLabelFromKey = (k) => {
    const [sport, abbr] = k.split('|');
    return teamName(sport, abbr);
  };
  const isProp = (b) => window.PROP_TYPES.includes(b.betType);
  const hasLegs = (b) => !!(b && b.legs && b.legs.length);
  const resultMark = (r) => (r === 'won' ? '✓' : r === 'lost' ? '✗' : r === 'push' ? '↺' : '…');
  const legsSummary = (b) => (b.legs || []).map((l) => `${resultMark(l.result)} ${betTitle(l)}`).join('  ·  ');
  // Does this bet (or any of its parlay legs) match the predicate?
  const anyPick = (b, fn) => fn(b) || (b.legs || []).some((l) => fn({ ...l, sport: l.sport || b.sport }));

  function betTitle(b) {
    if (b.pick) return b.pick;
    if (hasLegs(b)) return `${b.legs.length}-leg parlay`;
    const team = b.team ? teamName(b.sport, b.team) : '';
    const line = b.line !== '' && b.line != null ? String(b.line) : '';
    const signedLine = line && Number(line) > 0 ? '+' + line : line;
    switch (b.betType) {
      case 'Moneyline': return `${team || 'Team'} ML`;
      case 'Spread': return `${team || 'Team'} ${signedLine}`.trim();
      case 'Total': return `${b.side || ''} ${line}`.trim() + (team ? ` (${team}${b.opponent ? ' vs ' + teamName(b.sport, b.opponent) : ''})` : '');
      case 'Player Prop': return [b.player, b.side, line, b.propCategory].filter(Boolean).join(' ') || 'Player prop';
      case 'Game Prop': return [team, b.propCategory, b.side, line].filter(Boolean).join(' ') || 'Game prop';
      default: return team || b.betType || 'Bet';
    }
  }
  function betSub(b) {
    if (hasLegs(b)) return [b.sport, 'Parlay', b.book].filter(Boolean).join(' · ');
    const parts = [b.sport, b.betType];
    if (b.team && b.opponent) parts.push(`${b.team} vs ${b.opponent}`);
    else if (b.team && b.betType !== 'Moneyline' && b.betType !== 'Spread') parts.push(teamName(b.sport, b.team));
    if (b.book) parts.push(b.book);
    return parts.filter(Boolean).join(' · ');
  }

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2400);
  }

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    if (r.status === 401 && url !== '/api/auth/logout') {
      location.href = '/login';
      throw new Error('Sign in required');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  async function loadAll() {
    const [bets, notes, teamNotes, coaches, settings] = await Promise.all(
      ['bets', 'notes', 'teamNotes', 'coaches', 'settings'].map((c) => api('GET', '/api/' + c))
    );
    Object.assign(state, { bets, notes, teamNotes, coaches, settings: settings.find((x) => x.id === 'app') || {} });
  }

  // ---------- data mutations ----------

  async function saveBet(bet) {
    if (bet.id && state.bets.some((b) => b.id === bet.id)) {
      const saved = await api('PUT', '/api/bets/' + encodeURIComponent(bet.id), bet);
      state.bets = state.bets.map((b) => (b.id === saved.id ? saved : b));
      return saved;
    }
    const saved = await api('POST', '/api/bets', bet);
    state.bets.push(saved);
    return saved;
  }
  async function deleteBet(id) {
    await api('DELETE', '/api/bets/' + encodeURIComponent(id));
    state.bets = state.bets.filter((b) => b.id !== id);
  }
  async function settleLeg(betId, legId, result) {
    const bet = state.bets.find((b) => b.id === betId);
    if (!bet) return;
    const legs = bet.legs.map((l) => (l.id === legId ? { ...l, result } : l));
    const saved = await saveBet({ ...bet, legs, result: S.parlayResult(legs) });
    toast(saved.result === 'pending' ? `Leg marked ${result}` : `Leg marked ${result} · parlay ${saved.result}`);
    render();
  }
  async function settle(id, result) {
    const bet = state.bets.find((b) => b.id === id);
    if (!bet) return;
    await saveBet({ ...bet, result });
    toast(`Marked ${result}`);
    render();
  }
  async function saveNote(note) {
    if (note.id) {
      const saved = await api('PUT', '/api/notes/' + encodeURIComponent(note.id), note);
      state.notes = state.notes.map((n) => (n.id === saved.id ? saved : n));
    } else {
      state.notes.push(await api('POST', '/api/notes', note));
    }
  }
  async function saveTeamNotes(id, entries) {
    const saved = await api('PUT', '/api/teamNotes/' + encodeURIComponent(id), { entries });
    state.teamNotes = state.teamNotes.filter((t) => t.id !== id).concat(saved);
  }

  // ---------- routing ----------

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [pathPart, query = ''] = raw.split('?');
    return { parts: pathPart.split('/').map(decodeURIComponent), params: new URLSearchParams(query) };
  }

  const views = {
    dashboard: renderDashboard,
    bets: renderBets,
    bet: renderBetDetail,
    props: renderProps,
    insights: renderInsights,
    teams: renderTeams,
    team: renderTeamDetail,
    injuries: renderInjuries,
    matchups: renderMatchups,
    market: renderMarket,
    rankings: renderRankings,
    notes: renderNotes,
    settings: renderSettings,
  };
  const navFor = { bet: 'bets', team: 'teams' };

  function render() {
    const { parts, params } = parseHash();
    const view = views[parts[0]] ? parts[0] : 'dashboard';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (navFor[view] || view)));
    // On phones the nav scrolls sideways; keep the current page's tab in view.
    const nav = document.getElementById('nav');
    const cur = nav.querySelector('a.active');
    if (cur && nav.scrollWidth > nav.clientWidth) {
      const l = cur.offsetLeft - nav.offsetLeft, r = l + cur.offsetWidth;
      if (l < nav.scrollLeft || r > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = l - 24;
    }
    hideTooltip();
    views[view](parts.slice(1), params);
  }
  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });

  // ---------- shared fragments ----------

  function tilesHtml(s, extra = '') {
    const st = S.streak(state.bets);
    return `<div class="tiles">
      <div class="tile"><div class="label">Net profit</div><div class="value ${plClass(s.profit)}">${money(s.profit, true)}</div><div class="sub">on ${money(s.settledStaked)} settled</div></div>
      <div class="tile"><div class="label">Record (W-L-P)</div><div class="value">${s.won}-${s.lost}-${s.push}</div><div class="sub">${s.legs ? `${s.count} picks (${s.legs} parlay legs)` : `${s.count} bets total`}</div></div>
      <div class="tile"><div class="label">Win rate</div><div class="value">${pct(s.winRate)}</div><div class="sub">pushes excluded</div></div>
      <div class="tile"><div class="label">ROI</div><div class="value">${roiHtml(s.roi)}</div><div class="sub">profit ÷ settled stake</div></div>
      <div class="tile"><div class="label">Pending</div><div class="value">${s.pending}</div><div class="sub">${money(s.atRisk)} at risk</div></div>
      ${!extra && sizing() ? `<div class="tile"><div class="label">Bankroll</div><div class="value">${money(sizing().bankroll)}</div><div class="sub">1 unit = ${money(sizing().unit)}</div></div>` : ''}
      ${extra || (st ? `<div class="tile"><div class="label">Streak</div><div class="value ${st.type === 'won' ? 'pos' : 'neg'}">${st.type === 'won' ? 'W' : 'L'}${st.length}</div><div class="sub">current run</div></div>` : '')}
    </div>`;
  }

  const LEGS_NOTE = '<div class="muted small" style="margin:-4px 0 8px">Parlay legs count toward picks and success rate. Staked and P/L come from straight bets only, because a parlay\'s money belongs to the whole parlay.</div>';

  function groupTable(groups, { label, link, empty = 'No bets yet.', limit } = {}) {
    if (!groups.length) return `<div class="empty">${esc(empty)}</div>`;
    const rows = (limit ? groups.slice(0, limit) : groups)
      .map((g) => {
        const href = link ? link(g) : null;
        return `<tr${href ? ` class="clickable" data-href="${esc(href)}"` : ''}>
          <td class="c-label">${href ? `<a href="${esc(href)}">${esc(label ? label(g) : g.key)}</a>` : esc(label ? label(g) : g.key)}</td>
          <td class="num" data-label="Picks">${g.count}${g.legs ? `<span class="sub" title="Parlay legs included">${g.legs} in parlays</span>` : ''}</td>
          <td class="num" data-label="W-L-P">${record(g)}</td>
          <td data-label="Success">${meter(g.winRate)}</td>
          <td class="num hide-sm">${money(g.staked)}</td>
          <td class="num" data-label="P/L">${plHtml(g.profit)}</td>
          <td class="num hide-sm">${roiHtml(g.roi)}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table class="group-table">
      <thead><tr><th></th><th class="num">Picks</th><th class="num">W-L-P</th><th>Success rate</th><th class="num hide-sm">Staked</th><th class="num">P/L</th><th class="num hide-sm">ROI</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function betsTable(bets, { quickSettle = true, sortable = false } = {}) {
    if (!bets.length) return '<div class="empty">No bets match.</div>';
    const th = (key, text, cls = '') =>
      sortable
        ? `<th class="sortable ${cls}" data-sort="${key}">${text}${state.sort.key === key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`
        : `<th class="${cls}">${text}</th>`;
    const rows = bets
      .map((b) => {
        const p = S.betProfit(b);
        const nNotes = (b.notes || []).length;
        const settleBtns =
          quickSettle && hasLegs(b) && b.result === 'pending'
            ? `<a class="btn sm" href="#/bet/${encodeURIComponent(b.id)}">Settle legs</a>`
            : quickSettle && (!b.result || b.result === 'pending')
            ? `<div class="btn-row"><button class="btn sm win" data-settle="won" data-id="${esc(b.id)}" title="Mark won">W</button><button class="btn sm loss" data-settle="lost" data-id="${esc(b.id)}" title="Mark lost">L</button><button class="btn sm" data-settle="push" data-id="${esc(b.id)}" title="Mark push">P</button></div>`
            : '';
        return `<tr class="clickable" data-href="#/bet/${encodeURIComponent(b.id)}">
          <td class="hide-sm" style="white-space:nowrap">${fmtDate(b.date)}</td>
          <td class="c-title"><a href="#/bet/${encodeURIComponent(b.id)}">${esc(betTitle(b))}</a>${hasLegs(b) ? `<span class="sub legs-line">${esc(legsSummary(b))}</span>` : ''}<span class="sub">${esc(betSub(b))}<span class="show-sm"> · ${fmtDate(b.date)}</span>${nNotes ? ` · 📝 ${nNotes}` : ''}</span></td>
          <td class="num hide-sm">${oddsStr(b.odds)}</td>
          <td class="num c-stake">${money(b.stake)}<span class="sub show-sm-block">${oddsStr(b.odds)}</span></td>
          <td class="c-result">${badge(b.result)}</td>
          <td class="num c-pl">${b.result && b.result !== 'pending' ? plHtml(p) : `<span class="muted" title="To win">${money(S.winProfit(b.odds, b.stake))}</span>`}</td>
          <td class="c-act">${settleBtns}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table class="bets-table">
      <thead><tr>${th('date', 'Date', 'hide-sm')}${th('title', 'Bet')}${th('odds', 'Odds', 'num hide-sm')}${th('stake', 'Stake', 'num')}${th('result', 'Result')}${th('profit', 'P/L', 'num')}<th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function wireCommon(root = app) {
    root.querySelectorAll('tr[data-href]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a,button,input,select,textarea')) return;
        location.hash = tr.dataset.href;
      })
    );
    root.querySelectorAll('[data-settle]').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        settle(btn.dataset.id, btn.dataset.settle).catch((err) => toast(err.message));
      })
    );
  }

  // Notes log (used inside bets and teams)
  function notesLogHtml(entries, placeholder) {
    const list = (entries || [])
      .slice()
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map(
        (n) => `<div class="note" data-note-id="${esc(n.id)}">
          <div class="note-head"><span class="note-meta">${fmtDateTime(n.at)}${n.editedAt ? ' · edited' : ''}</span>
            <span class="btn-row"><button class="btn sm" data-note-edit="${esc(n.id)}">Edit</button><button class="btn sm danger" data-note-del="${esc(n.id)}">Delete</button></span></div>
          <div class="note-body">${esc(n.text)}</div>
        </div>`
      )
      .join('');
    return `<form class="note-add" style="margin-bottom:12px">
        <textarea name="text" placeholder="${esc(placeholder)}" rows="3" required></textarea>
        <div class="btn-row" style="margin-top:8px;justify-content:flex-end"><button class="btn primary" type="submit">Add note</button></div>
      </form>
      <div class="note-list">${list || '<div class="muted small">No notes yet.</div>'}</div>`;
  }

  function wireNotesLog(container, getEntries, persist) {
    container.querySelector('.note-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = e.target.text.value.trim();
      if (!text) return;
      await persist([...(getEntries() || []), { id: uid(), text, at: new Date().toISOString() }]);
      toast('Note added');
      render();
    });
    container.querySelectorAll('[data-note-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this note?')) return;
        await persist((getEntries() || []).filter((n) => n.id !== btn.dataset.noteDel));
        render();
      })
    );
    container.querySelectorAll('[data-note-edit]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.dataset.noteEdit;
        const entry = (getEntries() || []).find((n) => n.id === id);
        const box = container.querySelector(`[data-note-id="${CSS.escape(id)}"] .note-body`);
        box.outerHTML = `<form class="note-edit" style="margin-top:6px"><textarea name="text" rows="3">${esc(entry.text)}</textarea>
          <div class="btn-row" style="margin-top:6px;justify-content:flex-end"><button type="button" class="btn sm" data-cancel>Cancel</button><button class="btn sm primary" type="submit">Save</button></div></form>`;
        const form = container.querySelector(`[data-note-id="${CSS.escape(id)}"] .note-edit`);
        form.querySelector('[data-cancel]').addEventListener('click', render);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = form.text.value.trim();
          if (!text) return;
          await persist((getEntries() || []).map((n) => (n.id === id ? { ...n, text, editedAt: new Date().toISOString() } : n)));
          render();
        });
      })
    );
  }

  // ---------- chart ----------

  function plChart(series) {
    if (series.length < 2) return '<div class="empty">Settle at least two bets to see your profit curve.</div>';
    const W = 800, H = 260, m = { t: 12, r: 12, b: 26, l: 64 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = series.map((p) => p.total).concat(0);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const x = (i) => m.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const ticks = niceTicks(lo, hi, 4);
    const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join('');
    const area = `${path}L${x(series.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
    return `<div class="chart" id="plChart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit and loss over ${series.length} settled bets, ending at ${money(series[series.length - 1].total, true)}">
        <g class="axis">${ticks
          .map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${money(t, true)}</text>`)
          .join('')}
          <text x="${m.l}" y="${H - 6}">${fmtDate(series[0].date)}</text>
          <text x="${W - m.r}" y="${H - 6}" text-anchor="end">${fmtDate(series[series.length - 1].date)}</text>
        </g>
        <line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>
        <path class="area" d="${area}"/>
        <path class="line" d="${path}"/>
        <line class="cross" id="plCross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
        <circle class="dot" id="plDot" r="5" visibility="hidden"/>
        <rect id="plHit" x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>
      </svg></div>`;

    function niceTicks(a, b, n) {
      const step0 = (b - a) / n;
      const mag = Math.pow(10, Math.floor(Math.log10(step0)));
      const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || step0;
      const out = [];
      for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
      return out;
    }
  }

  function wirePlChart(series) {
    const el = document.getElementById('plChart');
    if (!el) return;
    const svg = el.querySelector('svg');
    const hit = svg.querySelector('#plHit');
    const cross = svg.querySelector('#plCross');
    const dot = svg.querySelector('#plDot');
    const W = 800, mL = 64, mR = 12, iw = W - mL - mR;
    const ys = series.map((p) => p.total);
    const vals = ys.concat(0);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const y = (v) => 12 + (1 - (v - lo) / (hi - lo)) * (260 - 12 - 26);
    let current = -1;
    const move = (e) => {
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(series.length - 1, Math.round(((sx - mL) / iw) * (series.length - 1))));
      const px = mL + (i / (series.length - 1)) * iw;
      const p = series[i];
      current = i;
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', y(p.total));
      dot.setAttribute('visibility', 'visible');
      showTooltip(
        e.clientX,
        e.clientY,
        `<strong>${fmtDate(p.date)}</strong><br>${esc(betTitle(p.bet))}<br>This bet: ${plHtml(p.profit)}<br>Running total: <strong>${plHtml(p.total)}</strong>`
      );
    };
    const leave = () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      current = -1;
      hideTooltip();
    };
    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', leave);
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => {
      if (current >= 0) location.hash = '#/bet/' + encodeURIComponent(series[current].bet.id);
    });
  }

  function showTooltip(cx, cy, html) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    let left = cx + 14, top = cy + 14;
    if (left + r.width > innerWidth - 8) left = cx - r.width - 14;
    if (top + r.height > innerHeight - 8) top = cy - r.height - 14;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function hideTooltip() {
    tooltip.hidden = true;
  }

  // ---------- views ----------

  function renderDashboard() {
    const bets = state.bets;
    const s = S.summarize(bets);
    const series = S.cumulative(bets);
    const legsNote = bets.some(hasLegs) ? LEGS_NOTE : '';
    const pending = bets.filter((b) => !b.result || b.result === 'pending').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const recent = bets
      .filter((b) => b.result && b.result !== 'pending')
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 8);

    app.innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><div class="muted">Your betting performance at a glance.</div></div></div>
      ${bets.length ? '' : `<div class="card empty"><h2>Welcome! 👋</h2><p>Start by logging your first bet. Every bet you track feeds the team, prop and success-rate stats.</p><button class="btn primary" data-add-bet>+ Add your first bet</button></div>`}
      ${tilesHtml(s)}
      <div class="card"><div class="card-head"><h2>Profit / loss over time</h2><span class="muted small">running total, settled bets</span></div>${plChart(series)}</div>
      <div class="card section"><div class="card-head"><h2>Pending bets</h2><a href="#/bets?result=pending">View all</a></div>${betsTable(pending.slice(0, 8))}</div>
      <div class="card section"><div class="card-head"><h2>Recently settled</h2><a href="#/bets">All bets</a></div>${betsTable(recent, { quickSettle: false })}</div>
      <div class="grid cols-2 section">
        <div class="card"><div class="card-head"><h2>Teams you've backed</h2><a href="#/teams">All teams</a></div>${legsNote}
          ${groupTable(S.groupStats(S.picks(bets), teamKey), { label: (g) => teamLabelFromKey(g.key), link: (g) => '#/team/' + g.key.split('|').map(encodeURIComponent).join('/'), limit: 6, empty: 'No team bets yet.' })}</div>
        <div class="card"><div class="card-head"><h2>Prop bets</h2><a href="#/props">All props</a></div>${legsNote}
          ${groupTable(S.groupStats(S.picks(bets).filter(isProp), (b) => b.propCategory || 'Uncategorized'), { link: (g) => '#/bets?prop=' + encodeURIComponent(g.key), limit: 6, empty: 'No prop bets yet.' })}</div>
      </div>
      <div class="grid cols-2 section">
        <div class="card"><h2>By bet type</h2>${groupTable(S.groupStats(bets, (b) => b.betType), { link: (g) => '#/bets?type=' + encodeURIComponent(g.key) })}</div>
        <div class="card"><h2>By sport</h2>${groupTable(S.groupStats(bets, (b) => b.sport), { link: (g) => '#/bets?sport=' + encodeURIComponent(g.key) })}</div>
      </div>`;
    wireCommon();
    wirePlChart(series);
    app.querySelectorAll('[data-add-bet]').forEach((b) => b.addEventListener('click', () => openBetForm()));
  }

  function sortBets(bets) {
    const { key, dir } = state.sort;
    const val = (b) =>
      key === 'title' ? betTitle(b).toLowerCase()
      : key === 'odds' ? Number(b.odds) || 0
      : key === 'stake' ? Number(b.stake) || 0
      : key === 'profit' ? S.betProfit(b)
      : key === 'result' ? b.result || 'pending'
      : String(b.date || '') + String(b.createdAt || '');
    return bets.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }

  function filterBets(params) {
    const q = (params.get('q') || '').toLowerCase();
    return state.bets.filter((b) => {
      if (params.get('sport') && b.sport !== params.get('sport')) return false;
      if (params.get('type') && b.betType !== params.get('type')) return false;
      if (params.get('result') && (b.result || 'pending') !== params.get('result')) return false;
      if (params.get('team') && !anyPick(b, (x) => x.team === params.get('team'))) return false;
      if (params.get('prop') && !anyPick(b, (x) => isProp(x) && (x.propCategory || 'Uncategorized') === params.get('prop'))) return false;
      if (params.get('player') && !anyPick(b, (x) => x.player === params.get('player'))) return false;
      if (params.get('from') && String(b.date) < params.get('from')) return false;
      if (params.get('to') && String(b.date) > params.get('to')) return false;
      if (q) {
        const hay = [betTitle(b), betSub(b), b.player, b.propCategory, teamName(b.sport, b.team), teamName(b.sport, b.opponent), b.book, ...(b.notes || []).map((n) => n.text),
          ...(b.legs || []).flatMap((l) => [betTitle(l), l.player, l.propCategory, teamName(l.sport || b.sport, l.team), teamName(l.sport || b.sport, l.opponent)])]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderBets(_, params) {
    const filtered = sortBets(filterBets(params));
    const s = S.summarize(filtered);
    const opt = (vals, sel, all) => `<option value="">${all}</option>` + vals.map((v) => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const sports = [...new Set(['NFL', 'NBA', ...state.bets.map((b) => b.sport).filter(Boolean)])];
    const allPicks = S.picks(state.bets);
    const teams = [...new Set(allPicks.map((b) => b.team).filter(Boolean))].sort();
    const props = [...new Set(allPicks.filter(isProp).map((b) => b.propCategory || 'Uncategorized'))].sort();
    const active = [...params.keys()].length;

    app.innerHTML = `
      <div class="page-head"><div><h1>Bets</h1><div class="muted">${filtered.length} of ${state.bets.length} bets · ${record(s)} · ${pct(s.winRate)} win rate · ${plHtml(s.profit)}</div></div>
        <div class="btn-row"><button class="btn" id="autoSettleBtn" title="Look up final scores and grade pending bets">⚡ Auto-settle</button><button class="btn" id="pasteSlipBtn">📷 Add from slip</button><button class="btn primary" data-add-bet>+ Add bet</button></div></div>
      <div class="card">
        <form class="filters" id="betFilters">
          <input type="search" name="q" placeholder="Search bets, players, notes…" value="${esc(params.get('q') || '')}">
          <select name="sport">${opt(sports, params.get('sport'), 'All sports')}</select>
          <select name="type">${opt(window.BET_TYPES, params.get('type'), 'All types')}</select>
          <select name="result">${opt(['pending', 'won', 'lost', 'push'], params.get('result'), 'All results')}</select>
          <select name="team">${opt(teams, params.get('team'), 'All teams')}</select>
          <select name="prop">${opt(props, params.get('prop'), 'All props')}</select>
          <input type="date" name="from" value="${esc(params.get('from') || '')}" title="From date">
          <input type="date" name="to" value="${esc(params.get('to') || '')}" title="To date">
          ${params.get('player') ? `<input type="hidden" name="player" value="${esc(params.get('player'))}"><span class="chip">Player: ${esc(params.get('player'))}</span>` : ''}
          ${active ? '<a class="btn" href="#/bets">Clear</a>' : ''}
        </form>
        ${betsTable(filtered, { sortable: true })}
      </div>`;

    const form = document.getElementById('betFilters');
    const apply = () => {
      const p = new URLSearchParams();
      for (const [k, v] of new FormData(form)) if (v) p.set(k, v);
      const qs = p.toString();
      history.replaceState(null, '', '#/bets' + (qs ? '?' + qs : ''));
      const focused = document.activeElement && document.activeElement.name;
      render();
      if (focused === 'q') {
        const input = app.querySelector('input[name=q]');
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    };
    form.addEventListener('change', apply);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      apply();
    });
    let t;
    form.q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(apply, 250);
    });
    app.querySelectorAll('th[data-sort]').forEach((th) =>
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'title' ? 1 : -1 };
        render();
      })
    );
    app.querySelector('[data-add-bet]').addEventListener('click', () => openBetForm());
    app.querySelector('#autoSettleBtn').addEventListener('click', () => runAutoSettle({ open: true }));
    app.querySelector('#pasteSlipBtn').addEventListener('click', () => openSlipImport());
    wireCommon();
  }

  function renderBetDetail([id]) {
    const b = state.bets.find((x) => x.id === id);
    if (!b) {
      app.innerHTML = '<div class="card empty">Bet not found. <a href="#/bets">Back to bets</a></div>';
      return;
    }
    const p = S.betProfit(b);
    const implied = S.impliedProbability(b.odds);
    const pending = !b.result || b.result === 'pending';
    const hasLeague = window.LEAGUES[b.sport];
    const parlay = hasLegs(b);
    const row = (k, v) => (v === '' || v == null ? '' : `<dt>${k}</dt><dd>${v}</dd>`);
    // teams/players to show injuries for, grouped by league
    const injuryGroups = {};
    for (const x of parlay ? b.legs.map((l) => ({ ...l, sport: l.sport || b.sport })) : [b]) {
      if (!window.LEAGUES[x.sport]) continue;
      const g = (injuryGroups[x.sport] = injuryGroups[x.sport] || { teams: [], players: [] });
      for (const t of [x.team, x.opponent]) if (t && !g.teams.includes(t)) g.teams.push(t);
      if (x.player) g.players.push(x.player);
    }
    const injurySports = Object.keys(injuryGroups).filter((sp) => injuryGroups[sp].teams.length);
    const settleBtns = (legId, size = '') =>
      ['won', 'lost', 'push']
        .map((r) => `<button class="btn ${size} ${r === 'won' ? 'win' : r === 'lost' ? 'loss' : ''}" data-leg="${esc(legId)}" data-leg-result="${r}" title="Mark ${r}">${r === 'won' ? 'W' : r === 'lost' ? 'L' : 'P'}</button>`)
        .join('');
    const teamLink = (sp, t) => (window.LEAGUES[sp] ? `<a href="#/team/${encodeURIComponent(sp)}/${encodeURIComponent(t)}">${esc(teamName(sp, t))}</a>` : esc(t));
    const legsCard = parlay
      ? `<div class="card section" id="legsCard"><div class="card-head"><h2>Parlay legs</h2><span class="muted small">${b.legs.filter((l) => l.result === 'won').length} of ${b.legs.length} hit · overall result is set from the legs</span></div>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>Leg</th><th class="num hide-sm">Odds</th><th>Result</th><th></th></tr></thead><tbody>
        ${b.legs
          .map((l, i) => {
            const sp = l.sport || b.sport;
            const bits = [sp, l.betType, l.team && l.opponent ? `${teamLink(sp, l.team)} vs ${teamLink(sp, l.opponent)}` : l.team ? teamLink(sp, l.team) : ''].filter(Boolean);
            return `<tr><td class="muted">${i + 1}</td>
              <td><strong>${esc(betTitle({ ...l, sport: sp }))}</strong><span class="sub">${bits.join(' · ')}</span></td>
              <td class="num hide-sm">${oddsStr(l.odds)}</td>
              <td>${badge(l.result)}</td>
              <td><div class="btn-row">${(l.result || 'pending') === 'pending' ? settleBtns(l.id, 'sm') : `<button class="btn sm" data-leg="${esc(l.id)}" data-leg-result="pending">Reopen</button>`}</div></td></tr>`;
          })
          .join('')}
        </tbody></table></div></div>`
      : '';

    app.innerHTML = `
      <div class="page-head">
        <div><a href="#/bets" class="small">← All bets</a><h1>${esc(betTitle(b))}</h1><div class="muted">${esc(betSub(b))} · ${fmtDate(b.date)}</div></div>
        <div class="btn-row">
          ${parlay ? '' : pending ? `<button class="btn win" data-settle="won" data-id="${esc(b.id)}">Mark won</button><button class="btn loss" data-settle="lost" data-id="${esc(b.id)}">Mark lost</button><button class="btn" data-settle="push" data-id="${esc(b.id)}">Push</button>` : `<button class="btn" data-settle="pending" data-id="${esc(b.id)}">Reopen</button>`}
          <button class="btn" id="editBet">Edit</button>
          <button class="btn" id="dupBet" title="Create a copy of this bet">Duplicate</button>
          <button class="btn danger" id="delBet">Delete</button>
        </div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h2>Details</h2>
          <dl class="kv">
            ${row('Result', badge(b.result))}
            ${row('Sport', esc(b.sport))}
            ${row('Bet type', esc(b.betType))}
            ${row('Legs', parlay ? `${b.legs.length} legs` : '')}
            ${b.team ? row('Team', hasLeague ? `<a href="#/team/${encodeURIComponent(b.sport)}/${encodeURIComponent(b.team)}">${esc(teamName(b.sport, b.team))}</a>` : esc(b.team)) : ''}
            ${b.opponent ? row('Opponent', hasLeague ? `<a href="#/team/${encodeURIComponent(b.sport)}/${encodeURIComponent(b.opponent)}">${esc(teamName(b.sport, b.opponent))}</a>` : esc(b.opponent)) : ''}
            ${row('Player', b.player ? `<a href="#/bets?player=${encodeURIComponent(b.player)}">${esc(b.player)}</a>` : '')}
            ${row('Prop', b.propCategory ? `<a href="#/bets?prop=${encodeURIComponent(b.propCategory)}">${esc(b.propCategory)}</a>` : '')}
            ${row('Side', esc(b.side))}
            ${row('Line', esc(b.line))}
            ${row('Pick', esc(b.pick))}
            ${row('Sportsbook', esc(b.book))}
            ${row('Odds', `${oddsStr(b.odds)}${implied != null ? ` <span class="muted small">(${pct(implied)} implied)</span>` : ''}`)}
            ${row('Stake', money(b.stake))}
            ${row('To win', money(S.winProfit(b.odds, b.stake)))}
            ${row('P/L', pending ? '<span class="muted">pending</span>' : plHtml(p) + (b.profitOverride !== '' && b.profitOverride != null ? ' <span class="muted small">(manual)</span>' : ''))}
            ${row('Logged', fmtDateTime(b.createdAt))}
          </dl>
        </div>
        <div class="card" id="betNotes"><div class="card-head"><h2>Notes on this bet</h2><span class="muted small">${plural((b.notes || []).length, 'note')}</span></div>
          ${notesLogHtml(b.notes, 'Why you made this pick, line movement, what happened…')}</div>
      </div>
      ${legsCard}
      ${b.betType === 'Player Prop' && b.player && window.LEAGUES[b.sport] ? '<div class="card section"><h2>🔍 Prop research</h2><div id="betResearch"></div></div>' : ''}
      ${injurySports
        .map((sp) => `<div class="card section"><div class="card-head"><h2>${injurySports.length > 1 ? esc(sp) + ' injury' : 'Injury'} report</h2><a href="#/injuries?league=${sp.toLowerCase()}">Full ${esc(sp)} report</a></div><div data-injuries="${esc(sp)}"></div></div>`)
        .join('')}`;

    wireCommon();
    document.getElementById('editBet').addEventListener('click', () => openBetForm(b));
    document.getElementById('dupBet').addEventListener('click', () => {
      const { id: _i, createdAt: _c, updatedAt: _u, notes: _n, ...rest } = b;
      const legs = (rest.legs || []).map((l) => ({ ...l, id: uid(), result: 'pending' }));
      openBetForm({ ...rest, legs, result: 'pending', date: today(), profitOverride: '' }, { duplicate: true });
    });
    document.getElementById('delBet').addEventListener('click', async () => {
      if (!confirm('Delete this bet and its notes? This cannot be undone.')) return;
      await deleteBet(b.id);
      toast('Bet deleted');
      location.hash = '#/bets';
    });
    wireNotesLog(
      document.getElementById('betNotes'),
      () => (state.bets.find((x) => x.id === id) || {}).notes,
      (notes) => saveBet({ ...state.bets.find((x) => x.id === id), notes })
    );
    const br = document.getElementById('betResearch');
    if (br) showResearch(br, { sport: b.sport, team: b.team, player: b.player, prop: b.propCategory, line: b.line, side: b.side, opp: b.opponent });
    for (const sp of injurySports) {
      renderTeamInjuriesInto(app.querySelector(`[data-injuries="${CSS.escape(sp)}"]`), sp, injuryGroups[sp].teams, injuryGroups[sp].players);
    }
    app.querySelectorAll('[data-leg]').forEach((btn) =>
      btn.addEventListener('click', () => settleLeg(b.id, btn.dataset.leg, btn.dataset.legResult).catch((err) => toast(err.message)))
    );
  }

  function renderProps(_, params) {
    const sport = params.get('sport') || '';
    const props = S.picks(state.bets).filter(isProp).filter((b) => !sport || b.sport === sport);
    const s = S.summarize(props);
    const link = (key, val) => (g) => `#/bets?${key}=${encodeURIComponent(g.key)}${sport ? '&sport=' + sport : ''}${val || ''}`;
    app.innerHTML = `
      <div class="page-head"><div><h1>Prop bets</h1><div class="muted">Success rate by prop category, side and player.</div></div>
        <div class="tabs" id="sportTabs">${['', 'NFL', 'NBA'].map((v) => `<button data-v="${v}" class="${v === sport ? 'active' : ''}">${v || 'All'}</button>`).join('')}</div></div>
      ${tilesHtml(s, ' ')}
      <div class="card"><h2>By prop category</h2>${props.some((p) => p.parlay) ? LEGS_NOTE : ''}
        ${groupTable(S.groupStats(props, (b) => b.propCategory || 'Uncategorized'), { link: link('prop'), empty: 'No prop bets yet. Add a bet with type "Player Prop" or "Game Prop".' })}</div>
      <div class="grid cols-2 section">
        <div class="card"><h2>By side (Over / Under / Yes / No)</h2>
          ${groupTable(S.groupStats(props, (b) => b.side || 'Unspecified'), {})}</div>
        <div class="card"><h2>Category × side</h2>
          ${groupTable(S.groupStats(props, (b) => (b.side ? `${b.propCategory || 'Uncategorized'} — ${b.side}` : null)), { empty: 'Set a side (Over/Under) on prop bets to see this.' })}</div>
      </div>
      <div class="card section"><h2>By player</h2>
        ${groupTable(S.groupStats(props, (b) => b.player), { link: link('player'), empty: 'No player props yet.' })}</div>`;
    app.querySelectorAll('#sportTabs button').forEach((btn) =>
      btn.addEventListener('click', () => (location.hash = '#/props' + (btn.dataset.v ? '?sport=' + btn.dataset.v : '')))
    );
    wireCommon();
  }

  // ---------- insights ----------

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const typeLabel = (b) => ({ 'Player Prop': 'player props', 'Game Prop': 'game props', Moneyline: 'moneylines', Spread: 'spreads', Total: 'totals', Parlay: 'parlays', Future: 'futures' }[b.betType] || 'other bets');
  const sideLabel = (b) => (b.side ? { Over: 'overs', Under: 'unders', Yes: '"yes" props', No: '"no" props' }[b.side] : '');

  function renderInsights(_, params) {
    const sport = params.get('sport') || '';
    const bets = state.bets.filter((b) => !sport || b.sport === sport);
    const picks = S.picks(bets).filter((x) => !sport || x.sport === sport);
    const straight = bets.filter((b) => !hasLegs(b));
    const decided = picks.filter((x) => x.result === 'won' || x.result === 'lost').length;

    // what you bet on: sport + type (+ side for totals/props)
    const byWhat = S.groupStats(picks, (x) => {
      const side = (x.betType === 'Total' || isProp(x)) && sideLabel(x);
      return side ? `${x.sport} ${isProp(x) ? (x.betType === 'Player Prop' ? 'player prop ' : 'game prop ') : ''}${side}` : `${x.sport} ${typeLabel(x)}`;
    });
    const byPropSide = S.groupStats(picks.filter(isProp), (x) => `${x.propCategory || 'Uncategorized'}${x.side ? ' ' + x.side.toLowerCase() : ''}`);
    const byDay = S.groupStats(bets, (b) => (b.date ? DAYS[new Date(b.date + 'T12:00:00').getDay()] : null)).sort((a, b) => DAYS.indexOf(a.key) - DAYS.indexOf(b.key));
    const byBook = S.groupStats(bets, (b) => b.book || 'No sportsbook entered');
    const byFav = S.groupStats(straight, (b) => (Number(b.odds) < 0 ? 'Favorites (minus odds)' : Number(b.odds) > 0 ? 'Underdogs (plus odds)' : null));
    const BUCKET_ORDER = ['Heavy', 'Favorite', 'Near', 'Underdog', 'Long'];
    const byOdds = S.groupStats(straight, (b) => S.oddsBucket(b.odds)).sort((a, b) => BUCKET_ORDER.findIndex((k) => a.key.startsWith(k)) - BUCKET_ORDER.findIndex((k) => b.key.startsWith(k)));
    const stakes = bets.map((b) => Number(b.stake) || 0).sort((a, b) => a - b);
    const median = stakes.length ? stakes[Math.floor(stakes.length / 2)] : 0;
    const byStake = S.groupStats(bets, (b) => (Number(b.stake) > median * 1.5 ? 'Bigger than usual' : Number(b.stake) < median * 0.67 ? 'Smaller than usual' : 'Your usual size'));
    const byFormat = S.groupStats(bets, (b) => (hasLegs(b) ? `Parlay (${b.legs.length >= 4 ? '4+' : b.legs.length} legs)` : 'Straight bet'));
    // which kinds of legs sink your parlays
    const lostLegs = bets.filter((b) => hasLegs(b) && b.result === 'lost').flatMap((b) => b.legs.filter((l) => l.result === 'lost'));
    const killers = Object.entries(lostLegs.reduce((m, l) => ((m[isProp(l) ? `${l.propCategory || 'Prop'}` : l.betType] = (m[isProp(l) ? `${l.propCategory || 'Prop'}` : l.betType] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);

    const t = S.takeaways([...byWhat, ...byPropSide.map((g) => ({ ...g, key: g.key + ' props' })), ...byDay.map((g) => ({ ...g, key: 'bets placed on ' + g.key + 's' })), ...byFav.map((g) => ({ ...g, key: g.key.toLowerCase() }))]);
    const line = (g, good) =>
      `<li class="${good ? 'pos' : 'neg'}">${good ? '🔥' : '🧊'} You're <strong>${record(g)}</strong> (${pct(g.winRate)}) on <strong>${esc(g.key)}</strong>${g.staked ? ` · ${plHtml(g.profit)}` : ''}</li>`;

    const card = (title, groups, hint) => `<div class="card"><h2>${title}</h2>${hint ? `<div class="muted small" style="margin:-6px 0 8px">${hint}</div>` : ''}${groupTable(groups, { empty: 'Not enough bets yet.' })}</div>`;
    app.innerHTML = `
      <div class="page-head"><div><h1>Insights</h1><div class="muted">Where you win and lose, from your own betting history.</div></div>
        <div class="tabs" id="sportTabs">${['', 'NFL', 'NBA'].map((v) => `<button data-v="${v}" class="${v === sport ? 'active' : ''}">${v || 'All'}</button>`).join('')}</div></div>
      ${decided < 10 ? `<div class="alert">You have ${plural(decided, 'settled pick')} so far. Insights get meaningful after 20–30, so treat these as early signals.</div>` : ''}
      <div class="grid cols-2">
        <div class="card"><h2>🔥 What's working</h2>${t.strengths.length ? `<ul class="takeaways">${t.strengths.map((g) => line(g, true)).join('')}</ul>` : '<div class="muted">Nothing stands out yet (needs at least 5 settled picks in a category).</div>'}</div>
        <div class="card"><h2>🧊 What's not</h2>${t.weaknesses.length ? `<ul class="takeaways">${t.weaknesses.map((g) => line(g, false)).join('')}</ul>` : '<div class="muted">Nothing stands out yet.</div>'}</div>
      </div>
      <p class="muted small">At typical -110 odds you need to win about <strong>52.4%</strong> to break even. Parlay legs count toward records but not money.</p>
      <div class="insight-tables section">
        ${card('By what you bet', byWhat)}
        ${card('Props by category & side', byPropSide)}
        ${card('By day you placed the bet', byDay)}
        ${card('By sportsbook', byBook)}
        ${card('Favorites vs underdogs', byFav, 'Straight bets only.')}
        ${card('By odds', byOdds, 'Straight bets only.')}
        ${card('By bet size', byStake, median ? `Compared with your typical stake (${money(median)}).` : '')}
        ${card('Straight bets vs parlays', byFormat)}
      </div>
      <div class="card section"><h2>💔 Legs that sank your parlays</h2>
        ${killers.length ? `<div class="btn-row">${killers.map(([k, n]) => `<span class="chip">${esc(k)}: ${n}</span>`).join('')}</div><div class="muted small" style="margin-top:6px">Losing legs in parlays you lost, by type. Frequent offenders might be better as straight bets, or left out.</div>` : '<div class="muted">No lost parlays with legs entered yet.</div>'}</div>`;
    app.querySelectorAll('#sportTabs button').forEach((btn) => btn.addEventListener('click', () => (location.hash = '#/insights' + (btn.dataset.v ? '?sport=' + btn.dataset.v : ''))));
    wireCommon();
  }

  function renderTeams(_, params) {
    const sport = params.get('sport') || '';
    const showAll = params.get('all') === '1';
    const bets = S.picks(state.bets).filter((b) => !sport || b.sport === sport);
    const groups = S.groupStats(bets, teamKey);
    const against = S.groupStats(bets.filter((b) => b.opponent && ['Moneyline', 'Spread'].includes(b.betType)), (b) => `${b.sport}|${b.opponent}`);
    const noteIds = new Set(state.teamNotes.filter((t) => (t.entries || []).length).map((t) => t.id));
    const teamLink = (k) => '#/team/' + k.split('|').map(encodeURIComponent).join('/');

    const leagues = sport ? [sport] : ['NFL', 'NBA'];
    const allTeams = leagues
      .map(
        (lg) => `<div class="section"><h3>${lg}</h3><div class="btn-row">${window.LEAGUES[lg]
          .map(([a, n]) => `<a class="chip" href="#/team/${lg}/${a}" title="${esc(n)}">${noteIds.has(lg + '-' + a) ? '📝 ' : ''}${esc(n)}</a>`)
          .join('')}</div></div>`
      )
      .join('');

    app.innerHTML = `
      <div class="page-head"><div><h1>Teams</h1><div class="muted">Success rate on teams you've put money on. Click a team for its bets, injuries and notes.</div></div>
        <div class="tabs" id="sportTabs">${['', 'NFL', 'NBA'].map((v) => `<button data-v="${v}" class="${v === sport ? 'active' : ''}">${v || 'All'}</button>`).join('')}</div></div>
      <div class="card"><h2>Teams you've bet on</h2>${bets.some((p) => p.parlay) ? LEGS_NOTE : ''}
        ${groupTable(groups, { label: (g) => `${teamLabelFromKey(g.key)} (${g.key.split('|')[0]})`, link: (g) => teamLink(g.key), empty: 'No team bets yet. Pick a team when you add a bet.' })}</div>
      <div class="card"><h2>Teams you've bet against</h2><div class="muted small" style="margin-bottom:8px">Moneyline & spread bets where this team was the opponent.</div>
        ${groupTable(against, { label: (g) => `${teamLabelFromKey(g.key)} (${g.key.split('|')[0]})`, link: (g) => teamLink(g.key), empty: 'Add an opponent on moneyline/spread bets to see this.' })}</div>
      <div class="card"><div class="card-head"><h2>All teams</h2><button class="btn sm" id="toggleAll">${showAll ? 'Hide' : 'Show'}</button></div>
        ${showAll ? allTeams : '<div class="muted small">Open any team to keep notes on it, even before you bet.</div>'}</div>`;

    app.querySelectorAll('#sportTabs button').forEach((btn) =>
      btn.addEventListener('click', () => {
        const p = new URLSearchParams();
        if (btn.dataset.v) p.set('sport', btn.dataset.v);
        if (showAll) p.set('all', '1');
        location.hash = '#/teams' + (p.toString() ? '?' + p : '');
      })
    );
    document.getElementById('toggleAll').addEventListener('click', () => {
      const p = new URLSearchParams(params);
      showAll ? p.delete('all') : p.set('all', '1');
      location.hash = '#/teams' + (p.toString() ? '?' + p : '');
    });
    wireCommon();
  }

  function renderTeamDetail([sport, abbr]) {
    const name = teamName(sport, abbr);
    const picks = S.picks(state.bets);
    const isOn = (x) => x.sport === sport && x.team === abbr;
    const isAgainst = (x) => x.sport === sport && x.opponent === abbr && ['Moneyline', 'Spread'].includes(x.betType);
    const s = S.summarize(picks.filter(isOn));
    const sa = S.summarize(picks.filter(isAgainst));
    // whole bets (straight or parlay) that include a pick on / against this team
    const on = state.bets.filter((b) => anyPick(b, isOn));
    const against = state.bets.filter((b) => !on.includes(b) && anyPick(b, isAgainst));
    const noteId = `${sport}-${abbr}`;
    const doc = state.teamNotes.find((t) => t.id === noteId);

    app.innerHTML = `
      <div class="page-head"><div><a href="#/teams" class="small">← Teams</a><h1>${esc(name)}</h1><div class="muted">${esc(sport)} · ${esc(abbr)}</div></div>
        <button class="btn primary" id="betOnTeam">+ Bet on ${esc(name)}</button></div>
      ${tilesHtml(s, `<div class="tile"><div class="label">Betting against</div><div class="value">${record(sa)}</div><div class="sub">${plHtml(sa.profit)} · ${pct(sa.winRate)}</div></div>`)}
      <div class="grid cols-2">
        <div class="card" id="teamNotes"><div class="card-head"><h2>Team notes</h2><span class="muted small">${plural(((doc && doc.entries) || []).length, 'note')}</span></div>
          ${notesLogHtml(doc && doc.entries, `Trends, matchups, coaching, travel spots for ${name}…`)}</div>
        <div class="card"><div class="card-head"><h2>Injury report</h2><a href="#/injuries?league=${sport.toLowerCase()}">Full ${esc(sport)} report</a></div><div id="teamInjuries"></div></div>
      </div>
      <div class="card section"><div class="card-head"><h2>Bets on ${esc(name)}</h2><a href="#/bets?team=${encodeURIComponent(abbr)}">Open in Bets</a></div>
        ${on.some(hasLegs) ? '<div class="muted small" style="margin:-4px 0 8px">Includes parlays with a leg on this team. The record above counts each leg on its own.</div>' : ''}
        ${betsTable(sortBets(on))}</div>
      ${against.length ? `<div class="card section"><h2>Bets against ${esc(name)}</h2>${betsTable(sortBets(against))}</div>` : ''}`;

    wireCommon();
    document.getElementById('betOnTeam').addEventListener('click', () => openBetForm({ sport, team: abbr }));
    wireNotesLog(
      document.getElementById('teamNotes'),
      () => (state.teamNotes.find((t) => t.id === noteId) || {}).entries,
      (entries) => saveTeamNotes(noteId, entries)
    );
    if (window.LEAGUES[sport]) renderTeamInjuriesInto(document.getElementById('teamInjuries'), sport, [abbr]);
    else document.getElementById('teamInjuries').innerHTML = '<div class="muted">Injury reports are available for NFL and NBA teams.</div>';
  }

  // ---------- injuries ----------

  // force: true = bypass the server cache too; 'background' = refetch quietly, keeping old data on screen
  async function loadInjuries(league, force) {
    const cur = state.injuries[league];
    if (cur && cur.loading) return cur.promise;
    if (cur && cur.data && !force) return cur;
    const entry = { loading: true, data: cur && cur.data };
    entry.promise = api('GET', `/api/injuries/${league}${force === true ? '?refresh=1' : ''}`)
      .then((data) => Object.assign(entry, { loading: false, data, error: data.stale ? data.error : null }))
      .catch((err) => Object.assign(entry, { loading: false, error: err.message, data: cur && cur.data }));
    state.injuries[league] = entry;
    return entry.promise;
  }

  function statusClass(status) {
    const s = String(status).toLowerCase();
    if (s.includes('out') || s.includes('injured reserve') || s === 'ir' || s.includes('suspension')) return 'out';
    if (s.includes('doubtful')) return 'doubtful';
    if (s.includes('questionable') || s.includes('day-to-day') || s.includes('probable')) return 'questionable';
    return 'other';
  }

  function findInjuryTeam(teams, sport, abbr) {
    const name = teamName(sport, abbr).toLowerCase();
    return teams.find((t) => t.abbr === abbr) || teams.find((t) => t.team.toLowerCase() === name);
  }

  function injuryTable(players, highlightPlayer) {
    if (!players.length) return '<div class="muted small">No injuries reported.</div>';
    const hps = [].concat(highlightPlayer || []).filter(Boolean).map((x) => x.toLowerCase());
    return `<div class="table-wrap"><table><thead><tr><th>Player</th><th>Pos</th><th>Status</th><th class="hide-sm">Injury</th><th class="hide-sm">Est. return</th><th>Update</th></tr></thead><tbody>${players
      .map(
        (p) => `<tr${hps.some((h) => p.name.toLowerCase().includes(h)) ? ' style="outline:2px solid var(--accent)"' : ''}>
        <td><strong>${esc(p.name)}</strong></td><td>${esc(p.position)}</td>
        <td><span class="badge ${statusClass(p.status)}">${esc(p.status || '—')}</span></td>
        <td class="hide-sm">${esc(p.injury || '—')}</td>
        <td class="hide-sm" style="white-space:nowrap">${p.returnDate ? fmtDate(p.returnDate.slice(0, 10)) : '—'}</td>
        <td class="small"${p.detail ? ` title="${esc(p.detail)}"` : ''}>${esc(p.comment || p.detail || '')}${p.date ? `<span class="sub">${fmtDate(p.date)}</span>` : ''}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
  }

  function renderTeamInjuriesInto(el, sport, abbrs, highlightPlayer) {
    const league = sport.toLowerCase();
    el.innerHTML = '<div class="muted">Loading injury report…</div>';
    loadInjuries(league).then(() => {
      if (!el.isConnected) return;
      const entry = state.injuries[league];
      if (!entry.data) {
        el.innerHTML = `<div class="alert error">${esc(entry.error || 'Injury report unavailable.')}</div>`;
        return;
      }
      el.innerHTML =
        (entry.error ? `<div class="alert">Showing cached data: ${esc(entry.error)}</div>` : '') +
        abbrs
          .map((a) => {
            const t = findInjuryTeam(entry.data.teams, sport, a);
            return `${abbrs.length > 1 ? `<h3>${esc(teamName(sport, a))}</h3>` : ''}${injuryTable(t ? t.players : [], highlightPlayer)}`;
          })
          .join('<div style="height:12px"></div>') +
        `<div class="muted small" style="margin-top:8px">Source: ESPN · updated ${fmtDateTime(entry.data.fetchedAt)}</div>`;
    });
  }

  function renderInjuries(_, params) {
    const league = params.get('league') === 'nba' ? 'nba' : 'nfl';
    const sport = league.toUpperCase();
    const entry = state.injuries[league];
    const q = (params.get('q') || '').toLowerCase();
    const team = params.get('team') || '';
    const status = params.get('status') || '';
    const mine = params.get('mine') === '1';

    const myTeams = new Set(state.bets.filter((b) => b.sport === sport).flatMap((b) => [b.team, b.opponent]).filter(Boolean));
    const pendingTeams = new Set(state.bets.filter((b) => b.sport === sport && (!b.result || b.result === 'pending')).flatMap((b) => [b.team, b.opponent]).filter(Boolean));
    const abbrOf = (t) => (window.LEAGUES[sport].find(([a, n]) => a === t.abbr || n.toLowerCase() === t.team.toLowerCase()) || [t.abbr])[0];

    let body;
    if (!entry || (entry.loading && !entry.data)) {
      body = '<div class="empty">Loading injury report…</div>';
      if (!entry) loadInjuries(league).then(render);
    } else if (!entry.data) {
      body = `<div class="alert error">${esc(entry.error)}</div><p class="muted">The injury feed comes from ESPN's public API. Make sure the server has internet access, then hit Refresh.</p>`;
    } else {
      const teams = entry.data.teams
        .map((t) => ({ ...t, code: abbrOf(t) }))
        .filter((t) => !team || t.code === team)
        .filter((t) => !mine || myTeams.has(t.code))
        .map((t) => ({
          ...t,
          players: t.players.filter(
            (p) => (!status || statusClass(p.status) === status) && (!q || `${p.name} ${p.position} ${p.injury} ${p.comment}`.toLowerCase().includes(q))
          ),
        }))
        .filter((t) => t.players.length);
      const total = teams.reduce((n, t) => n + t.players.length, 0);
      const open = team || q || teams.length <= 4;
      body =
        (entry.error ? `<div class="alert">Showing cached data: ${esc(entry.error)}</div>` : '') +
        `<div class="muted small" style="margin-bottom:12px">${total} players on ${teams.length} teams · Source: ESPN · updated ${fmtDateTime(entry.data.fetchedAt)} · refreshes automatically</div>` +
        (teams.length
          ? teams
              .map(
                (t) => `<details class="inj-team${pendingTeams.has(t.code) ? ' highlight' : ''}" ${open || pendingTeams.has(t.code) ? 'open' : ''}>
                <summary>${esc(t.team)}<span class="count">${t.players.length} listed${pendingTeams.has(t.code) ? ' · you have a pending bet' : ''}</span>
                  ${window.LEAGUES[sport].some(([a]) => a === t.code) ? ` · <a href="#/team/${sport}/${encodeURIComponent(t.code)}">team page</a>` : ''}</summary>
                ${injuryTable(t.players)}</details>`
              )
              .join('')
          : '<div class="empty">No injuries match these filters.</div>');
    }

    const opt = (vals, sel, all) => `<option value="">${all}</option>` + vals.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
    app.innerHTML = `
      <div class="page-head"><div><h1>Injury reports</h1><div class="muted">Live NFL & NBA injury lists. Teams with your pending bets are highlighted.</div></div>
        <div class="btn-row"><div class="tabs" id="leagueTabs">${['nfl', 'nba'].map((l) => `<button data-v="${l}" class="${l === league ? 'active' : ''}">${l.toUpperCase()}</button>`).join('')}</div>
        <button class="btn" id="refreshInj">↻ Refresh</button></div></div>
      <div class="card">
        <form class="filters" id="injFilters">
          <input type="hidden" name="league" value="${league}">
          <input type="search" name="q" placeholder="Search player or injury…" value="${esc(params.get('q') || '')}">
          <select name="team">${opt(window.LEAGUES[sport], team, 'All teams')}</select>
          <select name="status">${opt([['out', 'Out / IR'], ['doubtful', 'Doubtful'], ['questionable', 'Questionable / Day-to-day'], ['other', 'Other']], status, 'All statuses')}</select>
          <label class="btn-row" style="margin:0;color:var(--text)"><input type="checkbox" name="mine" value="1" ${mine ? 'checked' : ''} style="width:auto"> Only teams I've bet on</label>
        </form>
        ${body}
      </div>`;

    const form = document.getElementById('injFilters');
    const apply = () => {
      const p = new URLSearchParams();
      for (const [k, v] of new FormData(form)) if (v) p.set(k, v);
      history.replaceState(null, '', '#/injuries?' + p);
      const focusQ = document.activeElement && document.activeElement.name === 'q';
      render();
      if (focusQ) {
        const i = app.querySelector('input[name=q]');
        i.focus();
        i.setSelectionRange(i.value.length, i.value.length);
      }
    };
    form.addEventListener('change', apply);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      apply();
    });
    let t;
    form.q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(apply, 250);
    });
    app.querySelectorAll('#leagueTabs button').forEach((b) => b.addEventListener('click', () => (location.hash = '#/injuries?league=' + b.dataset.v)));
    document.getElementById('refreshInj').addEventListener('click', async () => {
      const p = loadInjuries(league, true);
      render();
      await p;
      render();
      toast('Injury report refreshed');
    });
  }

  // ---------- matchups ----------

  function loadSchedule(league, days, force) {
    const key = `${league}:${days}`;
    const cur = state.schedule[key];
    if (cur && cur.loading) return cur.promise;
    if (cur && cur.data && !force) return Promise.resolve(cur);
    const entry = { loading: true, data: cur && cur.data };
    entry.promise = api('GET', `/api/schedule/${league}?days=${days}${force === true ? '&refresh=1' : ''}`)
      .then((data) => Object.assign(entry, { loading: false, data, error: data.stale ? data.error : null }))
      .catch((err) => Object.assign(entry, { loading: false, error: err.message, data: cur && cur.data }));
    state.schedule[key] = entry;
    return entry.promise;
  }

  function loadH2H(league, a, b) {
    const key = `${league}:${a}:${b}`;
    const cur = state.h2h[key];
    if (cur && (cur.loading || cur.data)) return cur.promise || Promise.resolve(cur);
    const entry = { loading: true };
    entry.promise = api('GET', `/api/h2h/${league}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&n=5`)
      .then((data) => Object.assign(entry, { loading: false, data, error: null }))
      .catch((err) => Object.assign(entry, { loading: false, error: err.message }));
    state.h2h[key] = entry;
    return entry.promise;
  }

  const NOTE_ICONS = { blowout: '💥', close: '⏱️', offense: '⚡', defense: '🛡️' };

  function h2hHtml(league, a, b, overUnder) {
    const entry = state.h2h[`${league}:${a}:${b}`];
    if (!entry || entry.loading) return '<div class="muted small">Loading previous matchups…</div>';
    if (entry.error) return `<div class="alert error small">${esc(entry.error)}</div>`;
    const { summary: s, games } = entry.data;
    if (!games.length) return '<div class="muted small">No meetings found in recent seasons.</div>';
    const lead = s.wins[a] === s.wins[b] ? `Series tied ${s.wins[a]}-${s.wins[b]}` : s.wins[a] > s.wins[b] ? `${a} leads ${s.wins[a]}-${s.wins[b]}` : `${b} leads ${s.wins[b]}-${s.wins[a]}`;
    const ouCompare =
      overUnder != null && s.avgTotal != null
        ? ` <span class="muted">(this game's O/U ${esc(overUnder)}: ${s.avgTotal > overUnder ? 'past meetings ran higher' : s.avgTotal < overUnder ? 'past meetings ran lower' : 'right on it'})</span>`
        : '';
    const summary = `<div class="h2h-summary"><strong>Last ${plural(s.games, 'meeting')}:</strong> ${esc(lead)}${s.ties ? `, ${s.ties} tie${s.ties > 1 ? 's' : ''}` : ''}
      · Avg total <strong>${s.avgTotal}</strong> pts${ouCompare}
      · Avg margin ${esc(a)} ${s.avgMargin > 0 ? '+' : ''}${s.avgMargin}</div>`;
    const rows = games
      .map((g) => {
        const away = g.teams.find((t) => t.homeAway === 'away') || g.teams[0];
        const home = g.teams.find((t) => t !== away);
        const side = (t) => `<span class="${g.winner === t.abbr ? 'h2h-win' : ''}">${esc(t.abbr)} ${t.score}</span>`;
        const big = g.leaders.filter((l) => l.big);
        const rest = g.leaders.filter((l) => !l.big);
        return `<div class="h2h-game">
          <div class="h2h-line"><span class="muted small">${fmtDate(g.date.slice(0, 10))}${g.postseason ? ' · <span class="chip">Playoffs</span>' : ''}</span>
            <span class="h2h-score">${side(away)} <span class="muted">@</span> ${side(home)}</span></div>
          ${g.notes.length ? `<div class="h2h-notes">${g.notes.map((n) => `<span class="h2h-note ${esc(n.type)}">${NOTE_ICONS[n.type] || ''} ${esc(n.text)}</span>`).join('')}</div>` : ''}
          ${big.length ? `<div class="h2h-big">${big.map((l) => `<div>🔥 <strong>${esc(l.player)}</strong> <span class="muted small">${esc(l.team)}${l.position ? ' ' + esc(l.position) : ''}</span> · ${esc(l.display)}</div>`).join('')}</div>` : ''}
          ${rest.length ? `<div class="muted small h2h-leaders">${rest.map((l) => `${esc(l.label)}: ${esc(l.player)} (${esc(l.team)}) ${esc(l.display)}`).join(' · ')}</div>` : ''}
        </div>`;
      })
      .join('');
    return summary + rows;
  }

  const WEATHER_ICONS = { wind: '🌬️', rain: '🌧️', snow: '❄️', cold: '🥶', heat: '🥵' };
  function weatherHtml(w) {
    if (!w || w.loading) return '<span class="muted small">Loading weather…</span>';
    if (w.error) return `<span class="muted small">Weather unavailable</span>`;
    if (w.roof === 'dome') return `<span class="small">🏟️ Indoors${w.stadium ? ` <span class="muted">(${esc(w.stadium)})</span>` : ''}: weather won't matter</span>`;
    if (w.roof === 'neutral' || w.roof === 'unknown') return `<span class="muted small">${esc(w.note || '')}</span>`;
    if (w.status === 'too-far') return `<span class="muted small">🌤️ ${esc(w.note)}</span>`;
    if (w.status === 'past' || w.status === 'unavailable' || w.temp == null) return '';
    const flags = (w.flags || []).map((f) => `<span class="wx-flag ${esc(f.type)}">${WEATHER_ICONS[f.type] || ''} ${esc(f.text)}</span>`).join('');
    return `<div class="small">🌡️ <strong>${w.temp}°F</strong>${w.condition ? ` · ${esc(w.condition)}` : ''} · wind <strong>${w.wind ?? '—'} mph</strong>${w.gust ? ` (gusts ${w.gust})` : ''}${w.precipChance != null ? ` · ${w.precipChance}% chance of rain/snow` : ""}${w.roof === 'retractable' ? ' <span class="muted">(retractable roof, may be closed)</span>' : ''}</div>${flags ? `<div class="wx-flags">${flags}</div>` : ''}`;
  }

  const NFL_KEY_POS = ['QB', 'RB', 'WR', 'TE'];
  const isLongTerm = (status) => /injured reserve|^ir$|pup|physically unable|suspen|non-football/i.test(String(status));
  const severity = (status) => ({ out: 0, doubtful: 1, questionable: 2 }[statusClass(status)] ?? 3);

  // Injuries worth flagging for a game. NFL: every QB, plus skill players (RB/WR/TE) who
  // aren't on season-long lists. NBA: anyone out, doubtful, questionable or day-to-day.
  function notableInjuries(sport, players, showAll) {
    const list = players.filter((p) => {
      if (showAll) return true;
      if (sport === 'NFL') return p.position === 'QB' || (NFL_KEY_POS.includes(p.position) && !isLongTerm(p.status));
      return statusClass(p.status) !== 'other';
    });
    const posRank = (p) => (p.position === 'QB' ? 0 : sport === 'NFL' && NFL_KEY_POS.includes(p.position) ? 1 : 2);
    return list.sort((a, b) => posRank(a) - posRank(b) || severity(a.status) - severity(b.status) || a.name.localeCompare(b.name));
  }

  function injuryChip(p) {
    const qb = p.position === 'QB';
    return `<div class="inj-chip${qb ? ' qb' : ''}" title="${esc([p.injury, p.comment].filter(Boolean).join(' — '))}">
      <span class="pos">${esc(p.position || '—')}</span> <strong>${esc(p.name)}</strong>
      <span class="badge ${statusClass(p.status)}">${esc(p.status || '—')}</span>${p.injury ? ` <span class="muted small">${esc(p.injury)}</span>` : ''}</div>`;
  }

  function codeFor(sport, t) {
    const list = window.LEAGUES[sport] || [];
    const hit = list.find(([a]) => a === t.abbr) || list.find(([, n]) => n.toLowerCase() === String(t.name).toLowerCase());
    return hit ? hit[0] : t.abbr;
  }

  function fmtGameTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const dayKey = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  };

  function renderMatchups(_, params) {
    const league = params.get('league') === 'nba' ? 'nba' : 'nfl';
    const sport = league.toUpperCase();
    const days = Number(params.get('days')) || (league === 'nfl' ? 7 : 3);
    const team = params.get('team') || '';
    const showAll = params.get('all') === '1';
    const mine = params.get('mine') === '1';
    const sched = state.schedule[`${league}:${days}`];
    const inj = state.injuries[league];

    if (!sched) loadSchedule(league, days).then(render);
    if (!inj) loadInjuries(league).then(render);

    // pending picks (straight bets + parlay legs) by team code, for this league
    const pendingPicks = S.picks(state.bets).filter((x) => x.sport === sport && (x.result || 'pending') === 'pending');
    const picksFor = (h, a) => pendingPicks.filter((x) => [h, a].includes(x.team) || [h, a].includes(x.opponent));

    let body;
    if (!sched || (sched.loading && !sched.data)) {
      body = '<div class="empty">Loading schedule…</div>';
    } else if (!sched.data) {
      body = `<div class="alert error">${esc(sched.error)}</div><p class="muted">The schedule comes from ESPN's public API. Make sure the server has internet access, then hit Refresh.</p>`;
    } else {
      const injTeams = (inj && inj.data && inj.data.teams) || [];
      const games = sched.data.games
        .filter((g) => g.state !== 'post')
        .map((g) => ({ ...g, h: codeFor(sport, g.home), a: codeFor(sport, g.away) }))
        .filter((g) => !team || g.h === team || g.a === team)
        .filter((g) => !mine || picksFor(g.h, g.a).length);

      // QB watch: every QB on the injury report whose team plays in this window
      let qbWatch = '';
      if (sport === 'NFL' && injTeams.length) {
        const qbs = games.flatMap((g) =>
          [[g.a, g.away], [g.h, g.home]].flatMap(([code, t]) => {
            const it = findInjuryTeam(injTeams, sport, code);
            return (it ? it.players : []).filter((p) => p.position === 'QB').map((p) => ({ ...p, code, teamName: t.name, game: g }));
          })
        );
        if (qbs.length)
          qbWatch = `<div class="card qb-watch"><h2>🏈 QB watch</h2><div class="muted small" style="margin:-6px 0 10px">Quarterbacks on the injury report for teams playing in this window.</div>
            <div class="table-wrap"><table><thead><tr><th>QB</th><th>Team</th><th>Status</th><th class="hide-sm">Injury</th><th>Game</th></tr></thead><tbody>
            ${qbs
              .sort((x, y) => severity(x.status) - severity(y.status))
              .map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.code)}</td><td><span class="badge ${statusClass(p.status)}">${esc(p.status)}</span></td>
                <td class="hide-sm">${esc(p.injury || '—')}</td><td class="small">${esc(p.game.a)} @ ${esc(p.game.h)} · ${fmtGameTime(p.game.date)}</td></tr>`)
              .join('')}</tbody></table></div></div>`;
      }

      const card = (g) => {
        const my = picksFor(g.h, g.a);
        const live = g.state === 'in';
        const teamRow = (code, t, prefix) => `<div class="gt-row">
            ${t.logo ? `<img src="${esc(t.logo)}" alt="" width="24" height="24" loading="lazy">` : '<span class="logo-ph"></span>'}
            <span class="gt-name">${prefix}${window.LEAGUES[sport].some(([x]) => x === code) ? `<a href="#/team/${sport}/${encodeURIComponent(code)}">${esc(t.name)}</a>` : esc(t.name)}</span>
            <span class="muted small">${esc(t.record)}</span>${live && t.score !== '' ? `<strong class="gt-score">${esc(t.score)}</strong>` : ''}</div>`;
        const injBlock = (code, t) => {
          if (!inj || (inj.loading && !inj.data)) return `<div class="muted small">Loading injuries…</div>`;
          if (!inj.data) return '';
          const it = findInjuryTeam(injTeams, sport, code);
          const list = notableInjuries(sport, it ? it.players : [], showAll);
          return `<div class="gi-team"><div class="gi-head">${esc(code)}</div>${list.length ? list.map(injuryChip).join('') : `<div class="muted small">${showAll ? 'No injuries reported' : 'No notable injuries'}</div>`}</div>`;
        };
        return `<div class="game-card${my.length ? ' has-bet' : ''}">
          <div class="game-top"><span>${live ? `<span class="badge out">LIVE</span> ${esc(g.status)}` : fmtGameTime(g.date)}</span><span class="muted small">${esc(g.tv)}</span></div>
          ${teamRow(g.a, g.away, '')}
          ${teamRow(g.h, g.home, '<span class="muted">@ </span>')}
          ${g.spread || g.overUnder != null ? `<div class="game-lines">${g.spread ? `Line: <strong>${esc(g.spread)}</strong>` : ''}${g.spread && g.overUnder != null ? ' · ' : ''}${g.overUnder != null ? `O/U <strong>${esc(g.overUnder)}</strong>` : ''}</div>` : ''}
          ${g.venue ? `<div class="muted small">${esc(g.venue)}</div>` : ''}
          ${sport === 'NFL' && g.state === 'pre' ? `<div class="game-weather" data-weather="${esc(`${g.h}|${g.date}|${g.neutralSite ? 1 : 0}|${g.indoor ? 1 : 0}`)}">${weatherHtml(state.weather[`${g.h}|${g.date}|${g.neutralSite ? 1 : 0}|${g.indoor ? 1 : 0}`])}</div>` : ''}
          <div class="game-inj">${injBlock(g.a, g.away)}${injBlock(g.h, g.home)}</div>
          <details class="h2h" data-h2h="${esc(`${league}:${g.a}:${g.h}`)}" data-a="${esc(g.a)}" data-b="${esc(g.h)}" data-ou="${g.overUnder ?? ''}"${state.h2hOpen.has(`${league}:${g.a}:${g.h}`) ? ' open' : ''}>
            <summary>📜 Previous matchups</summary>
            <div class="h2h-body">${state.h2hOpen.has(`${league}:${g.a}:${g.h}`) ? h2hHtml(league, g.a, g.h, g.overUnder) : ''}</div>
          </details>
          ${my.length ? `<div class="game-mybets">📌 You have ${plural(my.length, 'pending pick')} on this game: ${my.map((x) => `<a href="#/bet/${encodeURIComponent((x.parlay || x).id)}">${esc(betTitle(x))}${x.parlay ? ' (parlay leg)' : ''}</a>`).join(', ')}</div>` : ''}
          <div class="btn-row game-actions">
            <button class="btn sm primary" data-niche="${esc(g.id)}">📊 Niche Stats</button>
            <button class="btn sm" data-bet-game="${esc(g.id)}" data-team="${esc(g.a)}" data-opp="${esc(g.h)}" data-date="${esc(g.date)}">+ Bet ${esc(g.a)}</button>
            <button class="btn sm" data-bet-game="${esc(g.id)}" data-team="${esc(g.h)}" data-opp="${esc(g.a)}" data-date="${esc(g.date)}">+ Bet ${esc(g.h)}</button>
          </div>
        </div>`;
      };

      const byDay = new Map();
      for (const g of games) {
        const k = dayKey(g.date);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(g);
      }
      body =
        (sched.error ? `<div class="alert">Showing cached schedule: ${esc(sched.error)}</div>` : '') +
        (inj && !inj.loading && !inj.data ? `<div class="alert">Injury report unavailable: ${esc(inj.error)}</div>` : '') +
        qbWatch +
        (games.length
          ? [...byDay.entries()].map(([day, list]) => `<h2 class="day-head">${esc(day)} <span class="muted small">${plural(list.length, 'game')}</span></h2><div class="game-grid">${list.map(card).join('')}</div>`).join('')
          : `<div class="card empty">${mine ? "No upcoming games involving your pending bets." : `No upcoming ${sport} games in the next ${plural(days, 'day')}.`}</div>`) +
        `<div class="muted small" style="margin-top:12px">Source: ESPN · schedule updated ${fmtDateTime(sched.data.fetchedAt)}${inj && inj.data ? ` · injuries updated ${fmtDateTime(inj.data.fetchedAt)}` : ''} · refreshes automatically (every minute during live games)</div>`;
    }

    const dayOpts = [[1, 'Today'], [3, 'Next 3 days'], [7, 'Next 7 days'], [14, 'Next 14 days']];
    app.innerHTML = `
      <div class="page-head"><div><h1>Matchups</h1><div class="muted">Upcoming games with notable injuries${sport === 'NFL' ? ' (QBs first)' : ''}. Games you have money on are highlighted.</div></div>
        <div class="btn-row"><div class="tabs" id="leagueTabs">${['nfl', 'nba'].map((l) => `<button data-v="${l}" class="${l === league ? 'active' : ''}">${l.toUpperCase()}</button>`).join('')}</div>
        <button class="btn" id="refreshSched">↻ Refresh</button></div></div>
      <form class="filters" id="mFilters">
        <input type="hidden" name="league" value="${league}">
        <select name="days">${dayOpts.map(([v, l]) => `<option value="${v}" ${v === days ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select name="team"><option value="">All teams</option>${window.LEAGUES[sport].map(([a, n]) => `<option value="${a}" ${a === team ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <label class="btn-row" style="margin:0;color:var(--text)"><input type="checkbox" name="all" value="1" ${showAll ? 'checked' : ''} style="width:auto"> Show all injuries</label>
        <label class="btn-row" style="margin:0;color:var(--text)"><input type="checkbox" name="mine" value="1" ${mine ? 'checked' : ''} style="width:auto"> Only games I've bet on</label>
      </form>
      ${body}`;

    const form = document.getElementById('mFilters');
    form.addEventListener('change', () => {
      const p = new URLSearchParams();
      for (const [k, v] of new FormData(form)) if (v) p.set(k, v);
      location.hash = '#/matchups?' + p;
    });
    app.querySelectorAll('#leagueTabs button').forEach((b) => b.addEventListener('click', () => (location.hash = '#/matchups?league=' + b.dataset.v)));
    document.getElementById('refreshSched').addEventListener('click', async () => {
      const a = loadSchedule(league, days, true);
      const b = loadInjuries(league, true);
      render();
      await Promise.all([a, b]);
      render();
      toast('Matchups refreshed');
    });
    app.querySelectorAll('details[data-h2h]').forEach((det) =>
      det.addEventListener('toggle', () => {
        const key = det.dataset.h2h;
        if (!det.open) return state.h2hOpen.delete(key);
        state.h2hOpen.add(key);
        const { a, b } = det.dataset;
        const ou = det.dataset.ou === '' ? null : Number(det.dataset.ou);
        const body = det.querySelector('.h2h-body');
        body.innerHTML = h2hHtml(league, a, b, ou);
        loadH2H(league, a, b).then(() => {
          if (body.isConnected) body.innerHTML = h2hHtml(league, a, b, ou);
          else if (state.h2hOpen.has(key)) render(); // page was redrawn while loading
        });
      })
    );
    app.querySelectorAll('[data-weather]').forEach((el) => {
      const key = el.dataset.weather;
      if (state.weather[key]) return;
      const [home, date, neutral, indoor] = key.split('|');
      state.weather[key] = { loading: true };
      api('GET', `/api/weather?${new URLSearchParams({ home, date, neutral, indoor })}`)
        .then((w) => (state.weather[key] = w))
        .catch((err) => (state.weather[key] = { error: err.message }))
        .then(() => app.querySelectorAll(`[data-weather="${CSS.escape(key)}"]`).forEach((x) => (x.innerHTML = weatherHtml(state.weather[key]))));
    });
    app.querySelectorAll('[data-niche]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const g = (sched && sched.data ? sched.data.games : []).find((x) => x.id === btn.dataset.niche);
        if (g) openNicheStats({ league, sport, a: codeFor(sport, g.away), h: codeFor(sport, g.home), game: g });
      })
    );
    app.querySelectorAll('[data-bet-game]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const d = new Date(btn.dataset.date);
        const date = isNaN(d) ? today() : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        openBetForm({ sport, team: btn.dataset.team, opponent: btn.dataset.opp, date });
      })
    );
  }

  // ---------- niche stats ----------

  const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  function gameSlots(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return {};
    const p = Object.fromEntries(ET_FMT.formatToParts(d).map((x) => [x.type, x.value]));
    const night = Number(p.hour) >= 19;
    return { primetime: night, mnf: p.weekday === 'Mon', tnf: p.weekday === 'Thu' && night, snf: p.weekday === 'Sun' && night };
  }

  function loadNiche(league, a, b, force) {
    const key = `${league}:${a}:${b}`;
    const cur = state.niche[key];
    if (cur && !force && (cur.loading || cur.data)) return cur.promise || Promise.resolve(cur);
    const entry = { loading: true };
    entry.promise = api('GET', `/api/niche/${league}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${force ? '&refresh=1' : ''}`)
      .then((data) => Object.assign(entry, { loading: false, data, error: null }))
      .catch((err) => Object.assign(entry, { loading: false, error: err.message }));
    state.niche[key] = entry;
    return entry.promise;
  }

  // --- coaching staffs (entered by you) and connections between them ---
  const COACH_ROLES = ['Head Coach', 'Offensive Coordinator', 'Defensive Coordinator', 'Special Teams Coordinator', 'QB Coach', 'Assistant', 'Other'];
  const staffOf = (sport, abbr) => ((state.coaches.find((c) => c.id === `${sport}-${abbr}`) || {}).staff || []);

  function mentionsTeam(text, sport, abbr) {
    if (!text) return false;
    const full = teamName(sport, abbr);
    const nick = full.split(' ').pop();
    const esc_ = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc_(abbr)}\\b`).test(text) || new RegExp(`\\b(${esc_(full)}|${esc_(nick)})\\b`, 'i').test(text);
  }

  function coachingConnections(sport, a, b) {
    const sa = staffOf(sport, a).map((c) => ({ ...c, team: a }));
    const sb = staffOf(sport, b).map((c) => ({ ...c, team: b }));
    const direct = [];
    for (const [list, other] of [[sa, b], [sb, a]]) {
      for (const c of list) if (mentionsTeam(c.history, sport, other)) direct.push({ coach: c, other });
    }
    const shared = [];
    for (const [x] of window.LEAGUES[sport] || []) {
      if (x === a || x === b) continue;
      const ca = sa.filter((c) => mentionsTeam(c.history, sport, x));
      const cb = sb.filter((c) => mentionsTeam(c.history, sport, x));
      if (ca.length && cb.length) shared.push({ team: x, coaches: [...ca, ...cb] });
    }
    return { direct, shared, entered: sa.length + sb.length };
  }

  function nicheHtml(ctx) {
    const { league, sport, a, h, game } = ctx;
    const entry = state.niche[`${league}:${a}:${h}`];
    const slots = sport === 'NFL' ? gameSlots(game.date) : {};
    const slotNames = [slots.mnf && 'Monday Night', slots.tnf && 'Thursday Night', slots.snf && 'Sunday Night', !slots.mnf && !slots.tnf && !slots.snf && slots.primetime && 'Primetime'].filter(Boolean);
    const head = `<div class="card-head" style="margin-bottom:4px"><h2>📊 Niche stats: ${esc(a)} @ ${esc(h)}</h2>
        <button type="button" class="btn sm" data-close>Close</button></div>
      <div class="muted small" style="margin-bottom:12px">${fmtGameTime(game.date)}${slotNames.length ? ` · <strong>${slotNames.join(' · ')}</strong>` : ''}${game.spread ? ` · Line ${esc(game.spread)}` : ''}${game.overUnder != null ? ` · O/U ${esc(game.overUnder)}` : ''}
      · <span class="hl-key">highlighted</span> = applies to this game</div>`;
    if (!entry || entry.loading) return head + '<div class="empty">Crunching the numbers… (the first time can take ~20 seconds while past betting lines are looked up)</div>';
    if (entry.error) return head + `<div class="alert error">${esc(entry.error)}</div>`;
    const ta = entry.data.teams[a] || {};
    const th = entry.data.teams[h] || {};

    // which team is favored in this game?
    const m = /^([A-Z]{2,4})\s+-/.exec(game.spread || '');
    const fav = m ? m[1] : null;
    const sameDiv = ta.division && ta.division === th.division;
    const lastResult = (t) => (t.recent && t.recent[0] ? t.recent[0].result : null);
    const relevantSplit = (key, team, isHome) =>
      key === 'overall' || (key === 'home' && isHome) || (key === 'away' && !isHome) || slots[key] ||
      (key === 'division' && sameDiv) || (key === 'afterLoss' && lastResult(team) === 'L') || (key === 'afterWin' && lastResult(team) === 'W');
    const relevantAts = (key, abbr, isHome) =>
      key === 'overall' || (key === 'home' && isHome) || (key === 'away' && !isHome) || (key === 'primetime' && slots.primetime) ||
      (key === 'fav' && fav === abbr) || (key === 'dog' && fav && fav !== abbr);

    const wl = (r) => (r && r.n ? `<strong>${r.w}-${r.l}${r.t ? '-' + r.t : ''}</strong> <span class="muted small">${pct(r.w + r.l ? r.w / (r.w + r.l) : null)}</span>` : '<span class="muted">—</span>');
    const atsCell = (r) => (r && r.n ? `<strong>${r.w}-${r.l}${r.p ? '-' + r.p : ''}</strong> <span class="muted small">${pct(r.w + r.l ? r.w / (r.w + r.l) : null)}</span>` : '<span class="muted">—</span>');
    const teamErr = (t) => (t.error ? `<div class="alert error small">${esc(t.abbr)}: ${esc(t.error)}</div>` : '');

    const splitKeys = [...new Set([...(ta.splits || []), ...(th.splits || [])].map((x) => x.key))];
    const findSplit = (t, k) => (t.splits || []).find((x) => x.key === k);
    const splitRows = splitKeys
      .map((k) => {
        const sa = findSplit(ta, k), sh = findSplit(th, k);
        const label = (sa || sh).label;
        return `<tr><td>${esc(label)}</td>
          <td class="${relevantSplit(k, ta, false) ? 'hl' : ''}">${wl(sa)}</td>
          <td class="${relevantSplit(k, th, true) ? 'hl' : ''}">${wl(sh)}</td></tr>`;
      })
      .join('');

    const atsKeys = [...new Set([...(ta.ats || []), ...(th.ats || [])].map((x) => x.key))];
    const findAts = (t, k) => (t.ats || []).find((x) => x.key === k);
    const atsRows = atsKeys
      .map((k) => {
        const xa = findAts(ta, k), xh = findAts(th, k);
        return `<tr><td>${esc((xa || xh).label)}</td>
          <td class="${relevantAts(k, a, false) ? 'hl' : ''}">${atsCell(xa)}</td>
          <td class="${relevantAts(k, h, true) ? 'hl' : ''}">${atsCell(xh)}</td></tr>`;
      })
      .join('');
    const ouCell = (t) =>
      t.ou && t.ou.n
        ? `<strong>${t.ou.over}-${t.ou.under}${t.ou.push ? '-' + t.ou.push : ''}</strong> <span class="muted small">overs ${pct(t.ou.over + t.ou.under ? t.ou.over / (t.ou.over + t.ou.under) : null)} · avg total ${t.ou.avgTotal}</span>`
        : '<span class="muted">—</span>';

    const conn = coachingConnections(sport, a, h);
    const coachLine = (t) => (t.headCoach ? `${esc(t.headCoach.name)}${t.headCoach.experience != null ? ` <span class="muted small">(${plural(t.headCoach.experience, 'season')} as HC)</span>` : ''}` : '<span class="muted">not listed</span>');
    const coachName = (c) => `${esc(c.role || 'Coach')} <strong>${esc(c.name)}</strong> <span class="muted small">(${esc(c.team)})</span>`;
    const coaching = `
      <h3 style="margin-top:18px">🧑‍🏫 Coaching</h3>
      <table class="niche-table"><thead><tr><th></th><th>${esc(a)}</th><th>${esc(h)}</th></tr></thead>
        <tbody><tr><td>Head coach (ESPN)</td><td>${coachLine(ta)}</td><td>${coachLine(th)}</td></tr></tbody></table>
      ${conn.direct.length || conn.shared.length
        ? `<ul class="conn-list">${conn.direct.map((d) => `<li>🔁 ${coachName(d.coach)} has history with <strong>${esc(teamName(sport, d.other))}</strong>: <span class="muted">${esc(d.coach.history)}</span></li>`).join('')}
            ${conn.shared.map((x) => `<li>🤝 Both staffs have ties to the <strong>${esc(teamName(sport, x.team))}</strong>: ${x.coaches.map(coachName).join(', ')}</li>`).join('')}</ul>`
        : `<div class="muted small">${conn.entered ? 'No coaching connections between these staffs.' : "No coordinators or assistants entered yet. Add them to spot coaches who've switched sides."}</div>`}
      <button type="button" class="btn sm" data-edit-coaches style="margin-top:8px">✏️ Edit coaching staffs</button>`;

    const recent = (t) => (t.recent || []).map((g) => `<span class="recent-chip ${g.result === 'W' ? 'w' : g.result === 'L' ? 'l' : ''}" title="${esc(fmtDate(g.date.slice(0, 10)))}">${g.result} ${g.home ? 'vs' : '@'} ${esc(g.opp)} ${g.teamScore}-${g.oppScore}</span>`).join(' ');
    const seasons = ta.seasons || th.seasons || [];
    return (
      head + teamErr(ta) + teamErr(th) +
      `<div class="niche-recent"><div><strong>${esc(a)}</strong> last 5: ${recent(ta) || '—'}</div><div><strong>${esc(h)}</strong> last 5: ${recent(th) || '—'}</div></div>
      <h3 style="margin-top:14px">📅 Situational records</h3>
      <div class="table-wrap"><table class="niche-table"><thead><tr><th></th><th>${esc(a)} (away)</th><th>${esc(h)} (home)</th></tr></thead><tbody>${splitRows}</tbody></table></div>
      <h3 style="margin-top:18px">💵 Against the spread</h3>
      <div class="table-wrap"><table class="niche-table"><thead><tr><th></th><th>${esc(a)}</th><th>${esc(h)}</th></tr></thead><tbody>${atsRows}
        <tr><td>Over / Under (O-U)</td><td>${ouCell(ta)}</td><td>${ouCell(th)}</td></tr></tbody></table></div>
      ${coaching}
      <p class="muted small" style="margin:14px 0 0">Records cover the ${seasons.length ? `${seasons[0]}–${seasons[seasons.length - 1]}` : 'recent'} seasons (regular season + playoffs)${ta.games ? `: ${ta.games} ${esc(a)} games, ${th.games || 0} ${esc(h)} games` : ''}.
        Against-the-spread and over/under use each team's last ${ta.atsGames || ATS_DEFAULT[league]} games with ESPN's closing line (${ta.gamesWithLine ?? '?'} and ${th.gamesWithLine ?? '?'} had a line).
        ${sport === 'NFL' ? 'Primetime = kickoff 7 PM ET or later.' : ''} Source: ESPN.</p>`
    );
  }
  const ATS_DEFAULT = { nfl: 40, nba: 30 };

  function coachEditorHtml(ctx) {
    const { sport, a, h } = ctx;
    const teamBlock = (abbr) => `<div class="coach-team" data-team="${esc(abbr)}"><h3>${esc(teamName(sport, abbr))}</h3>
      <div class="coach-rows">${staffOf(sport, abbr).map((c) => coachRowHtml(c)).join('')}</div>
      <button type="button" class="btn sm" data-add-coach="${esc(abbr)}">+ Add coach</button></div>`;
    return `<div class="card-head"><h2>✏️ Coaching staffs</h2><button type="button" class="btn sm" data-back>← Back to stats</button></div>
      <p class="muted small">Add coordinators and other coaches, with every team they've worked for (e.g. <em>"BUF 2018–21 (QB coach), SF 2022–24"</em>). Team abbreviations or names both work. Niche Stats flags coaches who used to work for the opponent, and staffs with a shared former team.</p>
      <div class="grid cols-2">${teamBlock(a)}${teamBlock(h)}</div>
      <div class="modal-actions"><button type="button" class="btn" data-back>Cancel</button><button type="button" class="btn primary" data-save-coaches>Save staffs</button></div>`;
  }
  const coachRowHtml = (c = {}) => `<div class="coach-row">
      <select data-k="role">${COACH_ROLES.map((r) => `<option ${r === (c.role || 'Offensive Coordinator') ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      <input data-k="name" value="${esc(c.name || '')}" placeholder="Name">
      <input data-k="history" value="${esc(c.history || '')}" placeholder="Previous teams, e.g. BUF 2018-21, SF 2022-24" class="full">
      <button type="button" class="btn sm danger" data-remove-coach title="Remove">✕</button></div>`;

  function openNicheStats(ctx) {
    let mode = 'stats';
    const draw = () => {
      modalForm.innerHTML = mode === 'stats' ? nicheHtml(ctx) : coachEditorHtml(ctx);
      modalForm.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => modal.close()));
      const edit = modalForm.querySelector('[data-edit-coaches]');
      if (edit) edit.addEventListener('click', () => ((mode = 'coaches'), draw()));
      modalForm.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => ((mode = 'stats'), draw())));
      modalForm.querySelectorAll('[data-add-coach]').forEach((b) =>
        b.addEventListener('click', () => {
          b.previousElementSibling.insertAdjacentHTML('beforeend', coachRowHtml());
          b.previousElementSibling.lastElementChild.querySelector('[data-k=name]').focus();
        })
      );
      modalForm.onclick = (e) => {
        const rm = e.target.closest('[data-remove-coach]');
        if (rm) rm.closest('.coach-row').remove();
      };
      const save = modalForm.querySelector('[data-save-coaches]');
      if (save)
        save.addEventListener('click', async () => {
          try {
            for (const block of modalForm.querySelectorAll('.coach-team')) {
              const id = `${ctx.sport}-${block.dataset.team}`;
              const staff = [...block.querySelectorAll('.coach-row')]
                .map((row) => Object.fromEntries([...row.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el.value.trim()])))
                .filter((c) => c.name)
                .map((c) => ({ id: uid(), ...c }));
              const saved = await api('PUT', '/api/coaches/' + encodeURIComponent(id), { staff });
              state.coaches = state.coaches.filter((c) => c.id !== id).concat(saved);
            }
            toast('Coaching staffs saved');
            mode = 'stats';
            draw();
          } catch (err) {
            alert(err.message);
          }
        });
    };
    modalForm.onsubmit = (e) => e.preventDefault();
    modal.classList.add('wide');
    draw();
    modal.showModal();
    loadNiche(ctx.league, ctx.a, ctx.h).then(() => {
      if (modal.open && mode === 'stats') draw();
    });
  }
  modal.addEventListener('close', () => {
    modal.classList.remove('wide');
    modalForm.onclick = null;
  });

  // ---------- market ----------

  const signed = (x) => (x == null ? '—' : x > 0 ? '+' + x : String(x));
  const lineFor = (team, game) => {
    // team's spread from the game's ESPN details ("KC -3.5")
    const m = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/.exec(game.spread || '');
    if (!m) return /^(EVEN|PK)/i.test(game.spread || '') ? 0 : '';
    return m[1] === team ? -Math.abs(Number(m[2])) : Math.abs(Number(m[2]));
  };
  const gameDateOnly = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? today() : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  function loadMarket(league, days, refresh) {
    const key = `${league}:${days}`;
    const cur = state.market[key];
    if (cur && cur.loading) return cur.promise;
    const entry = { loading: true, data: cur && cur.data };
    entry.promise = api('GET', `/api/market/${league}?days=${days}${refresh ? '&refresh=1' : ''}`)
      .then((data) => Object.assign(entry, { loading: false, data, error: null }))
      .catch((err) => Object.assign(entry, { loading: false, error: err.message }));
    state.market[key] = entry;
    return entry.promise;
  }

  function loadProps(league, gameId, refresh) {
    const key = `${league}:${gameId}`;
    const cur = state.props[key];
    if (cur && cur.loading) return cur.promise;
    const entry = { loading: true, data: cur && cur.data };
    entry.promise = api('GET', `/api/props/${league}/${encodeURIComponent(gameId)}${refresh ? '?refresh=1' : ''}`)
      .then((data) => Object.assign(entry, { loading: false, data, error: null }))
      .catch((err) => Object.assign(entry, { loading: false, error: err.message }));
    state.props[key] = entry;
    return entry.promise;
  }

  function moveHtml(open, now) {
    if (open == null || now == null || open === now) return '';
    const d = Math.round((now - open) * 10) / 10;
    return ` <span class="mv ${d > 0 ? 'up' : 'down'}" title="moved ${d > 0 ? '+' : ''}${d} since open">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  }

  function splitBar(label, leftName, leftPct, rightName) {
    if (leftPct === '' || leftPct == null) return '';
    const l = Number(leftPct);
    return `<div class="split-row"><span class="split-label">${esc(label)}</span>
      <div class="split-bar" title="${esc(leftName)} ${l}% · ${esc(rightName)} ${100 - l}%"><div class="split-l" style="width:${l}%"><span>${esc(leftName)} ${l}%</span></div><div class="split-r"><span>${100 - l}% ${esc(rightName)}</span></div></div></div>`;
  }

  function marketGameHtml(g, league) {
    const h = g.home.abbr, a = g.away.abbr;
    const cur = (g.lines && g.lines.current) || {};
    const espnOpen = g.lines && g.lines.open;
    const open = espnOpen || g.firstSeen || {};
    const openLabel = espnOpen ? `Open${g.lines.provider ? ` (${esc(g.lines.provider)})` : ''}` : g.firstSeen ? `First seen <span class="muted">${fmtDate(g.firstSeen.at.slice(0, 10))}</span>` : 'Open';
    const c = g.consensus;
    const best = (b, total) => (b ? `${b.point != null ? (total ? b.point : signed(b.point)) + ' ' : ''}<strong>${oddsStr(b.price)}</strong> <span class="muted small">${esc(b.book)}</span>` : '—');
    const spreadTxt = (x) => (x == null ? '—' : `${h} ${signed(x)}`);
    const s = g.splits;
    const signals = S.splitsSignals(s, { homeSpreadOpen: open.homeSpread, homeSpreadNow: cur.homeSpread, totalOpen: open.total, totalNow: cur.total }, { home: h, away: a });
    return `<div class="card mk-game" data-game="${esc(g.id)}">
      <div class="card-head"><h3 style="margin:0">${esc(g.away.name)} @ ${esc(g.home.name)}</h3><span class="muted small">${fmtGameTime(g.date)}${g.state === 'in' ? ' · <span class="badge out">LIVE</span>' : ''}</span></div>
      <div class="table-wrap"><table class="mk-table"><thead><tr><th></th><th>${openLabel}</th><th>Now (ESPN)</th><th>Consensus${c ? ` <span class="muted">(${c.books} books)</span>` : ''}</th><th>Best price</th></tr></thead><tbody>
        <tr><td>Spread</td><td>${spreadTxt(open.homeSpread)}</td><td>${spreadTxt(cur.homeSpread)}${moveHtml(open.homeSpread, cur.homeSpread)}</td><td>${c ? spreadTxt(c.consensus.homeSpread) : '—'}</td>
          <td>${c ? `${esc(h)} ${best(c.best.homeSpread)}<br>${esc(a)} ${best(c.best.awaySpread)}` : '—'}</td></tr>
        <tr><td>Total</td><td>${open.total ?? '—'}</td><td>${cur.total ?? '—'}${moveHtml(open.total, cur.total)}</td><td>${c && c.consensus.total != null ? c.consensus.total : '—'}</td>
          <td>${c ? `O ${best(c.best.over, true)}<br>U ${best(c.best.under, true)}` : '—'}</td></tr>
        <tr><td>Moneyline</td><td>${open.homeML != null ? `${esc(h)} ${oddsStr(open.homeML)}` : '—'}</td><td>${cur.homeML != null ? `${esc(h)} ${oddsStr(cur.homeML)} / ${esc(a)} ${oddsStr(cur.awayML)}` : '—'}</td>
          <td>${c && c.consensus.homeML != null ? `${esc(h)} ${oddsStr(Math.round(c.consensus.homeML))} / ${esc(a)} ${oddsStr(Math.round(c.consensus.awayML))}` : '—'}</td>
          <td>${c ? `${esc(h)} ${best(c.best.homeML)}<br>${esc(a)} ${best(c.best.awayML)}` : '—'}</td></tr>
      </tbody></table></div>
      <div class="mk-splits">
        <div class="card-head" style="margin:10px 0 4px"><strong>Public betting splits</strong><button type="button" class="btn sm" data-edit-splits="${esc(g.id)}">${s ? '✏️ Edit' : '+ Enter splits'}</button></div>
        ${s ? `${splitBar('Spread bets', h, s.homeBets, a)}${splitBar('Spread money', h, s.homeMoney, a)}${splitBar('Total bets', 'Over', s.overBets, 'Under')}${splitBar('Total money', 'Over', s.overMoney, 'Under')}
          ${signals.length ? `<ul class="signals">${signals.map((x) => `<li class="sig-${x.type}">${esc(x.text)}</li>`).join('')}</ul>` : '<div class="muted small">No strong signals in these splits.</div>'}
          <div class="muted small">Entered ${fmtDateTime(s.updatedAt)}</div>`
        : "<div class=\"muted small\">Bet % and money % aren't available from a free data feed. Copy them from a splits page and the site will flag sharp money, the public side and reverse line movement.</div>"}
        <div class="split-form" hidden></div>
      </div>
      <div class="btn-row" style="margin-top:8px"><a class="btn sm" href="#/market?league=${league}&view=props&game=${encodeURIComponent(g.id)}">🎯 Props${g.propsLoadedAt ? ' ✓' : ''}</a>
        <button type="button" class="btn sm" data-mk-bet="${esc(g.id)}" data-team="${esc(a)}">+ Bet ${esc(a)}</button><button type="button" class="btn sm" data-mk-bet="${esc(g.id)}" data-team="${esc(h)}">+ Bet ${esc(h)}</button></div>
    </div>`;
  }

  const SPLIT_LINKS = [
    ['SportsBettingDime', 'https://www.sportsbettingdime.com/{league}/public-betting-trends/'],
    ['VSIN (DraftKings splits)', 'https://data.vsin.com/betting-splits/'],
    ['Action Network public betting', 'https://www.actionnetwork.com/{league}/public-betting'],
    ['Covers consensus', 'https://contests.covers.com/consensus/topconsensus/{league}/overall'],
  ];

  function openSplitsForm(card, g, league) {
    const box = card.querySelector('.split-form');
    const s = g.splits || {};
    const h = g.home.abbr, a = g.away.abbr;
    box.hidden = false;
    box.innerHTML = `<form class="form-grid">
        <div class="field"><label>% of spread <strong>bets</strong> on ${esc(h)}</label><input name="homeBets" type="number" min="0" max="100" value="${esc(s.homeBets ?? '')}" placeholder="e.g. 68"></div>
        <div class="field"><label>% of spread <strong>money</strong> on ${esc(h)}</label><input name="homeMoney" type="number" min="0" max="100" value="${esc(s.homeMoney ?? '')}" placeholder="e.g. 45"></div>
        <div class="field"><label>% of total <strong>bets</strong> on the over</label><input name="overBets" type="number" min="0" max="100" value="${esc(s.overBets ?? '')}"></div>
        <div class="field"><label>% of total <strong>money</strong> on the over</label><input name="overMoney" type="number" min="0" max="100" value="${esc(s.overMoney ?? '')}"></div>
        <div class="full muted small">Enter the ${esc(h)} (home) side; ${esc(a)} is the rest. Free sources: ${SPLIT_LINKS.map(([n, u]) => `<a href="${u.replace('{league}', league)}" target="_blank" rel="noopener">${esc(n)}</a>`).join(' · ')}</div>
        <div class="full btn-row"><button class="btn primary" type="submit">Save splits</button><button class="btn" type="button" data-cancel>Cancel</button>${g.splits ? '<button class="btn danger" type="button" data-clear>Clear</button>' : ''}</div>
      </form>`;
    const f = box.querySelector('form');
    f.querySelector('[data-cancel]').addEventListener('click', () => (box.hidden = true));
    const clear = f.querySelector('[data-clear]');
    if (clear)
      clear.addEventListener('click', async () => {
        await api('DELETE', '/api/splits/' + encodeURIComponent(g.id));
        g.splits = null;
        render();
      });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (k) => (f[k].value === '' ? '' : Math.max(0, Math.min(100, Number(f[k].value))));
      g.splits = await api('PUT', '/api/splits/' + encodeURIComponent(g.id), { homeBets: v('homeBets'), homeMoney: v('homeMoney'), overBets: v('overBets'), overMoney: v('overMoney'), matchup: `${a} @ ${h}`, gameDate: g.date });
      toast('Splits saved');
      render();
    });
  }

  function openPasteSplits(games, league) {
    const sport = league.toUpperCase();
    modalForm.innerHTML = `
      <h2>📋 Paste betting splits</h2>
      <p class="muted small" style="margin-top:0">Open a page with public betting percentages, select the part with the games (Command + A copies the whole page; that's fine), copy, and paste it here. The site picks out bet % and money % for each of this week's games.
        Sources: ${SPLIT_LINKS.map(([n, u]) => `<a href="${u.replace('{league}', league)}" target="_blank" rel="noopener">${esc(n)}</a>`).join(' · ')}</p>
      <textarea name="text" rows="9" placeholder="e.g.\nPublic betting: 64% of bets are on the Bills, but 58% of the money is on Kansas City.\nThe over is getting 71% of tickets and 66% of the handle."></textarea>
      <div id="splitPreview"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" data-read>Read</button><button type="button" class="btn primary" data-save disabled>Save</button></div>`;
    modalForm.onsubmit = (e) => e.preventDefault();
    wireModalClose();
    modal.showModal();
    let found = {};
    const preview = modalForm.querySelector('#splitPreview');
    const save = modalForm.querySelector('[data-save]');
    const cell = (v) => (v == null ? '<span class="muted">—</span>' : `${v}%`);
    const read = () => {
      found = window.BetSplits.parseSplits(modalForm.text.value, games, window.LEAGUES, sport);
      const ids = Object.keys(found);
      preview.innerHTML = ids.length
        ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th></th><th>Game</th><th class="num">Spread bets (home)</th><th class="num">Spread money (home)</th><th class="num">Over bets</th><th class="num">Over money</th></tr></thead><tbody>
          ${ids.map((id) => { const r = found[id]; return `<tr><td><input type="checkbox" data-id="${esc(id)}" checked style="width:auto"></td><td>${esc(r.matchup)}</td><td class="num">${cell(r.homeBets)}</td><td class="num">${cell(r.homeMoney)}</td><td class="num">${cell(r.overBets)}</td><td class="num">${cell(r.overMoney)}</td></tr>`; }).join('')}
          </tbody></table></div><div class="muted small" style="margin-top:6px">Found splits for ${plural(ids.length, 'game')} of ${games.length}. Percentages are shown for the home team and the over. Untick anything that looks wrong. Saving only fills in the numbers found, and keeps anything you entered before.</div>`
        : '<div class="alert small" style="margin-top:10px">No splits found for this week\'s games. Make sure the text includes team names and percentages labeled as bets/tickets or money/handle. If it still doesn\'t work, send the text to Claude so the reader can be adjusted.</div>';
      save.disabled = !ids.length;
    };
    modalForm.querySelector('[data-read]').addEventListener('click', read);
    modalForm.text.addEventListener('paste', () => setTimeout(read, 0));
    save.addEventListener('click', async () => {
      const chosen = [...modalForm.querySelectorAll('#splitPreview input[data-id]:checked')].map((c) => c.dataset.id);
      try {
        for (const id of chosen) {
          const g = games.find((x) => x.id === id);
          const merged = { ...(g.splits || {}) };
          for (const [k, v] of Object.entries(found[id])) if (v != null && k !== 'matchup') merged[k] = v;
          g.splits = await api('PUT', '/api/splits/' + encodeURIComponent(id), { ...merged, matchup: found[id].matchup, gameDate: g.date, source: 'pasted' });
        }
        modal.close();
        toast(`Saved splits for ${plural(chosen.length, 'game')}`);
        render();
      } catch (err) {
        alert(err.message);
      }
    });
    modalForm.text.focus();
  }

  function oddsKeyNote() {
    return `<div class="card"><h3>🔑 Add a free Odds API key</h3><p>Consensus lines from many sportsbooks, best available prices and player props come from <a href="https://the-odds-api.com" target="_blank" rel="noopener">The Odds API</a>. The free plan includes 500 requests a month, plenty for checking a few games a week.</p>
      <ol class="phone-steps"><li>Go to <a href="https://the-odds-api.com" target="_blank" rel="noopener">the-odds-api.com</a> and click <strong>Get API Key</strong>, then choose the free plan.</li><li>They email you a key (a long string of letters and numbers).</li><li>Paste it in <a href="#/settings">Settings → Odds data</a>.</li></ol></div>`;
  }

  function propsViewHtml(league, games, gameId, params, md) {
    const g = games.find((x) => x.id === gameId) || games[0];
    if (!g) return '<div class="card empty">No upcoming games.</div>';
    const entry = state.props[`${league}:${g.id}`];
    const configured = md && md.data && md.data.odds.configured;
    const select = `<select id="propGame">${games.map((x) => `<option value="${esc(x.id)}" ${x.id === g.id ? 'selected' : ''}>${esc(x.away.abbr)} @ ${esc(x.home.abbr)} · ${fmtGameTime(x.date)}${x.propsLoadedAt ? ' ✓' : ''}</option>`).join('')}</select>`;
    if (!configured) return `<div class="filters">${select}</div>${oddsKeyNote()}`;
    let body;
    if (!entry || (entry.loading && !entry.data)) {
      body = entry
        ? '<div class="empty">Loading prop lines from sportsbooks…</div>'
        : `<div class="card empty"><p>Prop lines for this game aren't loaded yet.</p><button class="btn primary" id="loadProps">Load props</button><div class="muted small" style="margin-top:6px">Uses about ${league === 'nfl' ? 6 : 5} of your monthly Odds API requests; results are kept for 6 hours.</div></div>`;
    } else if (entry.error && !entry.data) {
      body = `<div class="alert error">${esc(entry.error)}</div>`;
    } else {
      const cat = params.get('cat') || '';
      const q = (params.get('q') || '').toLowerCase();
      const props = entry.data.props.filter((p) => (!cat || p.category === cat) && (!q || p.player.toLowerCase().includes(q)));
      const cats = [...new Set(entry.data.props.map((p) => p.category))];
      state.propsShown = props;
      body = `${entry.error ? `<div class="alert">${esc(entry.error)}</div>` : ''}
        <div class="filters"><select id="propCat"><option value="">All props</option>${cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <input type="search" id="propSearch" placeholder="Search player…" value="${esc(params.get('q') || '')}">
          <button class="btn sm" id="refreshProps">↻ Refresh (uses ~${league === 'nfl' ? 6 : 5})</button></div>
        <div class="muted small" style="margin-bottom:8px">${plural(entry.data.props.length, 'prop')} · updated ${fmtDateTime(entry.data.fetchedAt)}${entry.data.odds && entry.data.odds.remaining != null ? ` · ${entry.data.odds.remaining} Odds API requests left this month` : ''}</div>
        <div class="table-wrap"><table class="mk-props"><thead><tr><th>Player</th><th>Prop</th><th class="num">Consensus</th><th class="num hide-sm">First seen</th><th>Best over / yes</th><th>Best under / no</th><th class="num hide-sm">Books</th><th></th></tr></thead><tbody>
        ${props
          .map(
            (p, i) => `<tr><td><strong>${esc(p.player)}</strong></td><td>${esc(p.category)}</td>
            <td class="num">${p.yesNo ? '<span class="muted">yes/no</span>' : p.line ?? '—'}</td>
            <td class="num hide-sm">${p.firstSeen && p.firstSeen.line != null ? `${p.firstSeen.line}${moveHtml(p.firstSeen.line, p.line)}` : '—'}</td>
            <td>${p.over ? `${p.over.point != null ? 'o' + p.over.point + ' ' : ''}<strong>${oddsStr(p.over.price)}</strong> <span class="muted small">${esc(p.over.book)}</span>` : '—'}</td>
            <td>${p.under ? `${p.under.point != null ? 'u' + p.under.point + ' ' : ''}<strong>${oddsStr(p.under.price)}</strong> <span class="muted small">${esc(p.under.book)}</span>` : '—'}</td>
            <td class="num hide-sm">${p.books}</td>
            <td><div class="btn-row"><button class="btn sm" data-prop-research="${i}" title="Last 10 games vs this line">🔍</button><button class="btn sm" data-prop-bet="${i}">+ Bet</button></div></td></tr>
            <tr class="pr-row" hidden><td colspan="8"><div class="pr-slot"></div></td></tr>`
          )
          .join('')}</tbody></table></div>`;
    }
    return `<div class="filters">${select}</div>${body}`;
  }

  function trendItemHtml(x, kind) {
    const gameInfo = x.matchup ? `<span class="muted small">${esc(x.matchup)}${x.gameDate ? ' · ' + fmtGameTime(x.gameDate) : ''}</span>` : '';
    if (kind === 'team') {
      const target = x.suggest && x.suggest.side === 'opp' ? x.opp : x.team;
      let betBtn = '';
      if (x.suggest && x.suggest.betType === 'Spread') {
        betBtn = `<button class="btn sm" data-trend-bet="${esc(JSON.stringify({ type: 'Spread', team: target, opp: target === x.team ? x.opp : x.team, gameId: x.gameId }))}">+ Bet ${esc(target)} spread</button>`;
      } else if (x.suggest && x.suggest.betType === 'Total') {
        betBtn = `<button class="btn sm" data-trend-bet="${esc(JSON.stringify({ type: 'Total', team: x.team, opp: x.opp, side: x.suggest.side, gameId: x.gameId }))}">+ Bet ${esc(x.suggest.side.toLowerCase())}</button>`;
      }
      const tag = { ats: 'ATS', ou: 'O/U', situational: 'Situation' }[x.kind] || '';
      return `<li class="trend"><div><span class="trend-tag ${esc(x.kind)}">${tag}</span> <strong>${esc(teamName(state.trendSport, x.team))}</strong> ${esc(x.text)}</div><div class="trend-sub">${gameInfo}${betBtn ? `<span class="btn-row">${betBtn}</span>` : ''}</div></li>`;
    }
    const hit = (v) => (x.kind === 'propline' ? (x.side === 'Over' ? v > x.line : v < x.line) : v >= x.threshold);
    const recent = (x.recent || []).map((v) => `<span class="rv ${hit(v) ? 'hit' : 'miss'}">${v}</span>`).join('');
    const bet = { type: 'Player Prop', ...x.suggest, player: x.player, team: x.team, opp: x.opp, gameId: x.gameId };
    const research = { player: x.player, team: x.team, opp: x.opp, cat: x.category, line: x.suggest.line, side: x.suggest.side };
    return `<li class="trend"><div><strong>${esc(x.player)}</strong> <span class="muted small">${esc(x.team)}</span> · ${esc(x.text)}${x.price ? ` <span class="muted small">(best ${oddsStr(x.price.price)} ${esc(x.price.book)})</span>` : ''}</div>
      <div class="trend-sub"><span class="small">${x.hits}/${x.of} last ${x.of} · avg ${x.avg} · recent ${recent}</span>${gameInfo}
        <span class="btn-row"><button class="btn sm" data-trend-research="${esc(JSON.stringify(research))}" title="Research">🔍</button><button class="btn sm" data-trend-bet="${esc(JSON.stringify(bet))}">+ Bet</button></span></div></li>`;
  }

  function streaksViewHtml(league, days, params) {
    const t = state.trends[`${league}:${days}`];
    if (!t || (t.status === 'building' && !t.data)) {
      const p = t && t.progress;
      return `<div class="card empty"><h3>🔎 Scanning teams and players…</h3>${
        p && p.total
          ? `<div class="progress"><div style="width:${Math.round((p.done / p.total) * 100)}%"></div></div><div class="muted small">${p.done} of ${p.total} teams · the first scan takes a few minutes; after that it's quick</div>`
          : '<div class="muted small">Starting…</div>'
      }</div>`;
    }
    if (t.status === 'error' && !t.data) return `<div class="alert error">${esc(t.error)}</div>`;
    const d = t.data;
    state.trendSport = league.toUpperCase();
    const cat = params.get('cat') || '';
    const players = d.players.filter((x) => !cat || x.category === cat);
    const cats = [...new Set(d.players.map((x) => x.category))];
    const situ = d.teams.filter((x) => x.kind === 'situational');
    const atsou = d.teams.filter((x) => x.kind !== 'situational');
    return `${t.status === 'building' ? '<div class="alert small">Refreshing in the background…</div>' : ''}
      <div class="alert small">Streaks describe the past, and sportsbooks know about them too. Use them as a starting point for research, not as sure things.</div>
      <div class="grid cols-2">
        <div class="card"><h2>📈 Team streaks</h2>${atsou.length ? `<ul class="trends">${atsou.slice(0, 25).map((x) => trendItemHtml(x, 'team')).join('')}</ul>` : "<div class=\"muted\">No notable streaks for this week's teams.</div>"}</div>
        <div class="card"><h2>🌙 Situational spots this week</h2><div class="muted small" style="margin:-6px 0 8px">Records in the exact situation each team is in this week (night game, home/road, favorite/underdog).</div>${situ.length ? `<ul class="trends">${situ.slice(0, 25).map((x) => trendItemHtml(x, 'team')).join('')}</ul>` : '<div class="muted">Nothing stands out.</div>'}</div>
      </div>
      <div class="card section"><h2>🎯 Player streaks vs this week's lines</h2>
        ${d.propLines.length ? `<ul class="trends">${d.propLines.slice(0, 30).map((x) => trendItemHtml(x, 'player')).join('')}</ul>` : `<div class="muted">${d.propsAvailable ? 'No players are on a run against the current lines.' : 'Load props for a game in the <strong>Props</strong> view to compare players with the real lines.'}</div>`}</div>
      <div class="card section"><div class="card-head"><h2>🔥 Player milestone streaks</h2><select id="streakCat"><option value="">All categories</option>${cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        ${players.length ? `<ul class="trends">${players.slice(0, 60).map((x) => trendItemHtml(x, 'player')).join('')}</ul>` : '<div class="muted">No current streaks found.</div>'}</div>
      <p class="muted small">Scanned ${plural(d.games, 'upcoming game')} · built ${fmtDateTime(d.builtAt)} · <button class="btn sm" id="rebuildTrends">↻ Rescan</button> · Source: ESPN box scores and closing lines.</p>`;
  }

  let trendsPoll = null;
  async function pollTrends(league, days, refresh) {
    clearTimeout(trendsPoll);
    trendsPoll = true;
    try {
      state.trends[`${league}:${days}`] = await api('GET', `/api/trends/${league}?days=${days}${refresh ? '&refresh=1' : ''}`);
    } catch (err) {
      state.trends[`${league}:${days}`] = { status: 'error', error: err.message };
    }
    const { parts, params } = parseHash();
    const stillHere = parts[0] === 'market' && params.get('view') === 'streaks';
    if (stillHere) quietRender();
    trendsPoll = state.trends[`${league}:${days}`].status === 'building' && stillHere ? setTimeout(() => pollTrends(league, days), 3000) : null;
  }

  function openResearchModal(q) {
    modalForm.innerHTML = `<div class="card-head"><h2 style="margin:0">🔍 Prop research</h2><button type="button" class="btn sm" data-close>Close</button></div><div id="rmOut"></div>`;
    modalForm.onsubmit = (e) => e.preventDefault();
    wireModalClose();
    modal.showModal();
    showResearch(modalForm.querySelector('#rmOut'), q);
  }

  function marketBet(spec, games, sport) {
    const g = games.find((x) => x.id === spec.gameId) || {};
    const base = { sport, date: g.date ? gameDateOnly(g.date) : today() };
    if (spec.type === 'Spread') return openBetForm({ ...base, betType: 'Spread', team: spec.team, opponent: spec.opp, line: g.spread ? lineFor(spec.team, g) : '' });
    if (spec.type === 'Total') return openBetForm({ ...base, betType: 'Total', team: spec.team, opponent: spec.opp, side: spec.side, line: g.overUnder ?? '' });
    return openBetForm({ ...base, betType: 'Player Prop', player: spec.player, team: spec.team || '', opponent: spec.opp || '', propCategory: spec.propCategory, side: spec.side, line: spec.line ?? '', odds: spec.odds ?? -110 });
  }

  function renderMarket(_, params) {
    const league = params.get('league') === 'nba' ? 'nba' : 'nfl';
    const sport = league.toUpperCase();
    const view = params.get('view') || 'lines';
    const days = Number(params.get('days')) || (league === 'nfl' ? 7 : 2);
    const key = `${league}:${days}`;
    const md = state.market[key];
    if (!md) loadMarket(league, days).then(quietRender);
    const games = (md && md.data && md.data.games) || [];
    const setParam = (k, v) => {
      const p = new URLSearchParams(params);
      if (v) p.set(k, v);
      else p.delete(k);
      if (k !== 'cat' && k !== 'q') {
        p.delete('cat');
        p.delete('q');
      }
      location.hash = '#/market?' + p;
    };

    let body;
    if (view === 'streaks') {
      const t = state.trends[key];
      if ((!t || t.status === 'building') && !trendsPoll) pollTrends(league, days);
      body = streaksViewHtml(league, days, params);
    } else if (!md || (md.loading && !md.data)) {
      body = '<div class="empty">Loading lines…</div>';
    } else if (md.error && !md.data) {
      body = `<div class="alert error">${esc(md.error)}</div>`;
    } else if (view === 'props') {
      body = propsViewHtml(league, games, params.get('game'), params, md);
    } else {
      const o = md.data.odds;
      body = `${
        o.configured
          ? `<div class="muted small" style="margin-bottom:10px">Consensus from The Odds API${o.fetchedAt ? ` · updated ${fmtDateTime(o.fetchedAt)}` : ''}${o.remaining != null ? ` · ${o.remaining} requests left this month` : ''} · <button class="btn sm" id="refreshOdds">↻ Refresh odds (uses 3)</button>${o.error ? ` <span class="neg">${esc(o.error)}</span>` : ''}</div>`
          : oddsKeyNote()
      }
        <div class="btn-row" style="margin-bottom:10px"><button class="btn" id="pasteSplits">📋 Paste splits for all games</button><span class="muted small">bet % and money % from SportsBettingDime, VSIN, Action Network…</span></div>
        <div class="muted small" style="margin-bottom:10px">"Open" is the opening line from ESPN when it provides one; otherwise it's the line the first time this site saw the game. Spreads are shown from the home team's side.</div>
        ${games.length ? games.map((g) => marketGameHtml(g, league)).join('') : `<div class="card empty">No upcoming ${sport} games in the next ${plural(days, 'day')}.</div>`}`;
    }

    app.innerHTML = `
      <div class="page-head"><div><h1>Market</h1><div class="muted">Line movement, public betting splits, prop consensus and streaks.</div></div>
        <div class="btn-row"><div class="tabs" id="leagueTabs">${['nfl', 'nba'].map((l) => `<button data-v="${l}" class="${l === league ? 'active' : ''}">${l.toUpperCase()}</button>`).join('')}</div>
        <select id="mkDays">${(league === 'nfl' ? [[7, 'Next 7 days'], [14, 'Next 14 days']] : [[1, 'Today'], [2, 'Next 2 days'], [3, 'Next 3 days']]).map(([v, l]) => `<option value="${v}" ${v === days ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="tabs subtabs" id="mkViews">${[['lines', '📈 Lines & splits'], ['props', '🎯 Props'], ['streaks', '🔥 Streaks']].map(([v, l]) => `<button data-v="${v}" class="${v === view ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="section">${body}</div>`;

    app.querySelectorAll('#leagueTabs button').forEach((b) => b.addEventListener('click', () => (location.hash = `#/market?league=${b.dataset.v}${view !== 'lines' ? '&view=' + view : ''}`)));
    app.querySelectorAll('#mkViews button').forEach((b) => b.addEventListener('click', () => setParam('view', b.dataset.v === 'lines' ? '' : b.dataset.v)));
    app.querySelector('#mkDays').addEventListener('change', (e) => setParam('days', e.target.value));
    const ro = app.querySelector('#refreshOdds');
    if (ro)
      ro.addEventListener('click', async () => {
        ro.disabled = true;
        await loadMarket(league, days, true);
        render();
      });
    const pss = app.querySelector('#pasteSplits');
    if (pss) pss.addEventListener('click', () => openPasteSplits(games, league));
    app.querySelectorAll('[data-edit-splits]').forEach((b) =>
      b.addEventListener('click', () => openSplitsForm(b.closest('.mk-game'), games.find((g) => g.id === b.dataset.editSplits), league))
    );
    app.querySelectorAll('[data-mk-bet]').forEach((b) =>
      b.addEventListener('click', () => {
        const g = games.find((x) => x.id === b.dataset.mkBet);
        marketBet({ type: 'Spread', team: b.dataset.team, opp: b.dataset.team === g.home.abbr ? g.away.abbr : g.home.abbr, gameId: g.id }, games, sport);
      })
    );

    // props view
    const pg = app.querySelector('#propGame');
    if (pg) pg.addEventListener('change', () => setParam('game', pg.value));
    const currentGame = () => (pg ? pg.value : null);
    const lp = app.querySelector('#loadProps');
    if (lp)
      lp.addEventListener('click', () => {
        loadProps(league, currentGame()).then(() => render());
        render();
      });
    const rp = app.querySelector('#refreshProps');
    if (rp) rp.addEventListener('click', () => loadProps(league, currentGame(), true).then(() => render()));
    const pc = app.querySelector('#propCat');
    if (pc) pc.addEventListener('change', () => setParam('cat', pc.value));
    const ps = app.querySelector('#propSearch');
    if (ps) {
      let t;
      ps.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          const p = new URLSearchParams(params);
          if (ps.value) p.set('q', ps.value);
          else p.delete('q');
          history.replaceState(null, '', '#/market?' + p);
          render();
          const el = app.querySelector('#propSearch');
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }, 250);
      });
    }
    app.querySelectorAll('[data-prop-research]').forEach((b) =>
      b.addEventListener('click', async () => {
        const p = state.propsShown[Number(b.dataset.propResearch)];
        const row = b.closest('tr').nextElementSibling;
        row.hidden = !row.hidden;
        if (row.hidden) return;
        const slot = row.querySelector('.pr-slot');
        const side = p.yesNo ? 'Yes' : 'Over';
        slot.innerHTML = '<div class="muted small">Looking up recent games…</div>';
        // the props feed doesn't say which team the player is on, so try both
        for (const [i, team] of p.teams.entries()) {
          try {
            const d = await loadResearch({ sport, team, player: p.player, prop: p.category, line: p.line ?? '', side, opp: p.teams[1 - i] });
            p.team = team;
            slot.innerHTML = researchHtml(d);
            return;
          } catch (err) {
            if (i === p.teams.length - 1) slot.innerHTML = `<div class="alert small">${esc(err.message)}</div>`;
          }
        }
      })
    );
    app.querySelectorAll('[data-prop-bet]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = state.propsShown[Number(b.dataset.propBet)];
        const g = games.find((x) => x.id === currentGame()) || {};
        marketBet({ type: 'Player Prop', player: p.player, team: p.team || '', opp: p.team ? p.teams.find((t) => t !== p.team) : '', propCategory: p.category, side: p.yesNo ? 'Yes' : 'Over', line: p.line ?? '', odds: p.over ? p.over.price : -110, gameId: g.id }, games, sport);
      })
    );

    // streaks view
    const sc = app.querySelector('#streakCat');
    if (sc) sc.addEventListener('change', () => setParam('cat', sc.value));
    const rb = app.querySelector('#rebuildTrends');
    if (rb) rb.addEventListener('click', () => pollTrends(league, days, true));
    app.querySelectorAll('[data-trend-bet]').forEach((b) => b.addEventListener('click', () => marketBet(JSON.parse(b.dataset.trendBet), games, sport)));
    app.querySelectorAll('[data-trend-research]').forEach((b) =>
      b.addEventListener('click', () => {
        const x = JSON.parse(b.dataset.trendResearch);
        openResearchModal({ sport, team: x.team, player: x.player, prop: x.cat, line: x.line ?? '', side: x.side, opp: x.opp });
      })
    );
  }

  // ---------- notes ----------

  // ---------- rankings ----------

  const ordinal = (n) => {
    if (n == null) return '—';
    const v = n % 100;
    return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th');
  };
  const RK_SIDES = {
    def: { title: 'Defense', overall: 'def.yards', cols: ['def.yards', 'def.points', 'def.pass', 'def.rush', 'def.ypc', 'def.sacks', 'def.ints', 'def.fumbles', 'def.takeaways', 'def.passTd', 'def.rushTd', 'def.third'] },
    off: { title: 'Offense', overall: 'off.yards', cols: ['off.yards', 'off.points', 'off.pass', 'off.rush', 'off.passTd', 'off.rushTd', 'off.turnovers', 'off.ypc', 'off.sackRate', 'off.oline', 'off.third'] },
  };
  const RK_CHIP = {
    'def.yards': 'Overall', 'def.points': 'Points allowed', 'def.pass': 'vs pass', 'def.rush': 'vs run', 'def.ypc': 'YPC allowed', 'def.sacks': 'Sacks',
    'def.ints': 'Interceptions', 'def.fumbles': 'Fumbles recovered', 'def.takeaways': 'Takeaways', 'def.passTd': 'Pass TDs allowed', 'def.rushTd': 'Rush TDs allowed', 'def.third': '3rd down',
    'off.yards': 'Overall', 'off.points': 'Points', 'off.pass': 'Passing', 'off.rush': 'Rushing', 'off.passTd': 'Passing TDs', 'off.rushTd': 'Rushing TDs',
    'off.turnovers': 'Turnovers', 'off.ypc': 'Yards per carry', 'off.sackRate': 'Sacks allowed', 'off.oline': 'O-line', 'off.third': '3rd down',
  };

  let rankingsPoll = null;
  async function pollRankings(refresh) {
    clearTimeout(rankingsPoll);
    rankingsPoll = true;
    try {
      state.rankings = await api('GET', `/api/rankings/nfl${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      state.rankings = { status: 'error', error: err.message };
    }
    const here = parseHash().parts[0] === 'rankings';
    if (here) quietRender();
    rankingsPoll = state.rankings.status === 'building' && here ? setTimeout(() => pollRankings(), 2500) : null;
  }

  function rkValue(m, row) {
    const v = row.values[m.key];
    if (m.key === 'off.oline') return v == null ? '—' : `${row.ranks['off.sackRate'] || '—'} · ${row.ranks['off.ypc'] || '—'}`;
    if (v == null) return '—';
    if (m.fmt === 'pct') return (v * 100).toFixed(1) + '%';
    if (m.fmt === 'count') return String(row.totals[m.key] ?? '—');
    return v.toFixed(1);
  }

  function renderRankings(_, params) {
    const view = ['standings', 'def', 'off', 'outliers'].includes(params.get('view')) ? params.get('view') : 'standings';
    const r = state.rankings;
    if (!r && rankingsPoll == null) pollRankings();
    const d = r && r.data;
    const tabs = [['standings', 'Standings'], ['def', 'Defense'], ['off', 'Offense'], ['outliers', `Outliers${d ? ` (${d.outliers.length})` : ''}`]];
    const head = `<div class="page-head"><div><h1>Rankings</h1><div class="muted">${
      d ? `NFL ${d.season} regular season · ${plural(d.games, 'game')} played${d.currentSeason ? '' : ' · the new season hasn’t started, so this is last season'}` : 'NFL standings, team rankings and games that skew the averages.'
    }</div></div>
      <button class="btn" id="rkRefresh" ${r && r.status === 'building' ? 'disabled' : ''}>↻ Refresh</button></div>
      <div class="tabs subtabs" id="rkTabs">${tabs.map(([v, l]) => `<button data-v="${v}" class="${v === view ? 'active' : ''}">${l}</button>`).join('')}</div>`;

    let body;
    if (!r || (r.status === 'building' && !d)) {
      const p = r && r.progress;
      body = `<div class="card empty section"><h3>Adding up this season's games…</h3>${
        p && p.total ? `<div class="progress"><div style="width:${Math.round((p.done / p.total) * 100)}%"></div></div><div class="muted small">${p.done} of ${p.total} box scores · the first time takes a minute; after that only new games are fetched</div>` : '<div class="muted small">Finding this season’s games…</div>'
      }</div>`;
    } else if (!d) {
      body = `<div class="alert error section">Couldn't build the rankings: ${esc(r.error || 'unknown error')}. Try Refresh in a minute.</div>`;
    } else {
      const pendingTeams = new Set(S.picks(state.bets).filter((x) => (x.result || 'pending') === 'pending' && x.sport === 'NFL').flatMap((x) => [x.team, x.opponent]).filter(Boolean));
      const flagged = {};
      for (const o of d.outliers) (flagged[`${o.side}:${o.team}`] = flagged[`${o.side}:${o.team}`] || []).push(o);
      const ctx = { d, params, pendingTeams, flagged };
      body =
        (r.status === 'building' ? '<div class="alert small section">Updating in the background…</div>' : '') +
        (view === 'standings' ? standingsHtml(ctx) : view === 'outliers' ? outliersHtml(ctx) : rankTableHtml(view, ctx)) +
        `<p class="muted small" style="margin-top:16px">Source: ESPN box scores · updated ${fmtDateTime(d.builtAt)}${d.missing ? ` · ${plural(d.missing, 'game')} couldn't be loaded` : ''}</p>`;
    }
    app.innerHTML = head + body;

    app.querySelectorAll('#rkTabs button').forEach((b) =>
      b.addEventListener('click', () => {
        const p = new URLSearchParams();
        p.set('view', b.dataset.v);
        location.hash = '#/rankings?' + p;
      })
    );
    app.querySelector('#rkRefresh').addEventListener('click', () => pollRankings(true));
    const sorted = app.querySelector('.rk-table th.rk-sorted');
    if (sorted) {
      const wrap = sorted.closest('.table-wrap');
      const sticky = [...wrap.querySelectorAll('thead th')].slice(0, 2).reduce((w, th) => w + th.offsetWidth, 0);
      if (sorted.offsetLeft + sorted.offsetWidth > wrap.clientWidth) wrap.scrollLeft = sorted.offsetLeft - sticky - 8;
    }
    app.querySelectorAll('[data-rk-sort]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = new URLSearchParams(params);
        p.set('sort', b.dataset.rkSort);
        history.replaceState(null, '', '#/rankings?' + p);
        render();
      })
    );
    app.querySelectorAll('[data-rk-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = new URLSearchParams(params);
        b.dataset.rkFilter ? p.set('side', b.dataset.rkFilter) : p.delete('side');
        p.delete('team');
        history.replaceState(null, '', '#/rankings?' + p);
        render();
      })
    );
    wireCommon();
  }

  const nflName = (abbr) => teamName('NFL', abbr);
  const teamCell = (abbr, ctx, extra = '') =>
    `<a href="#/team/NFL/${encodeURIComponent(abbr)}" class="rk-team${ctx.pendingTeams.has(abbr) ? ' has-bet' : ''}" title="${ctx.pendingTeams.has(abbr) ? 'You have a pending bet on this team' : ''}">${esc(nflName(abbr))}</a>${extra}`;

  function standingsHtml(ctx) {
    const order = [0, 4, 1, 5, 2, 6, 3, 7]; // AFC and NFC divisions side by side
    const card = (div) => `<div class="card rk-div"><h2>${esc(div.name)}</h2><div class="table-wrap"><table class="rk-standings">
      <thead><tr><th>Team</th><th class="num">W-L${div.teams.some((t) => t.t) ? '-T' : ''}</th><th class="num">Pct</th><th class="num hide-sm">Div</th><th class="num hide-sm rk-pfpa">PF</th><th class="num hide-sm rk-pfpa">PA</th><th class="num">Diff</th><th class="num">Strk</th><th class="hide-sm">Last 5</th></tr></thead>
      <tbody>${div.teams
        .map(
          (t) => `<tr><td>${teamCell(t.abbr, ctx)}</td><td class="num">${t.w}-${t.l}${t.t ? `-${t.t}` : ''}</td><td class="num">${t.pct.toFixed(3).replace(/^0/, '')}</td>
            <td class="num hide-sm">${esc(t.div)}</td><td class="num hide-sm rk-pfpa">${t.pf}</td><td class="num hide-sm rk-pfpa">${t.pa}</td>
            <td class="num ${t.diff > 0 ? 'pos' : t.diff < 0 ? 'neg' : ''}">${t.diff > 0 ? '+' : ''}${t.diff}</td><td class="num">${esc(t.streak || '—')}</td>
            <td class="hide-sm"><span class="rk-form">${[...t.last5].map((x) => `<span class="rk-res ${x.toLowerCase()}" title="${x === 'W' ? 'Win' : x === 'L' ? 'Loss' : 'Tie'}">${x}</span>`).join('')}</span></td></tr>`
        )
        .join('')}</tbody></table></div></div>`;
    return `<div class="grid cols-2 section rk-divs">${order.map((i) => card(ctx.d.standings[i])).join('')}</div>
      <p class="muted small" style="margin-top:12px">Ordered by win %, then division record, conference record and point differential. The NFL's full tiebreakers (head-to-head, common games, strength of victory) aren't applied.</p>`;
  }

  function rankTableHtml(side, ctx) {
    const { d, params } = ctx;
    const conf = RK_SIDES[side];
    const metrics = Object.fromEntries(d.metrics.map((m) => [m.key, m]));
    const sortKey = conf.cols.includes(params.get('sort')) ? params.get('sort') : conf.overall;
    const rows = d.teams.slice().sort((a, b) => (a.ranks[sortKey] ?? 99) - (b.ranks[sortKey] ?? 99) || a.abbr.localeCompare(b.abbr));
    const n = d.teams.length;
    const tone = (rank) => (rank == null ? '' : rank <= 8 ? 'rk-top' : rank > n - 8 ? 'rk-bottom' : '');
    const sm = metrics[sortKey];
    const note =
      sortKey === 'off.oline'
        ? 'O-line ranks blend pass protection (sack rate allowed) and run blocking (yards per carry). The column shows those two ranks.'
        : sm.total
        ? `${esc(sm.label)} are ranked per game, so a bye week doesn't count against a team. The column shows the season total.`
        : '';
    const chips = conf.cols.map((k) => `<button class="chip-btn ${k === sortKey ? 'active' : ''}" data-rk-sort="${k}">${esc(RK_CHIP[k])}</button>`).join('');
    const flagChip = (abbr) => {
      const f = ctx.flagged[`${side}:${abbr}`];
      return f ? ` <a class="rk-flag" href="#/rankings?view=outliers&team=${encodeURIComponent(abbr)}" title="${esc(f.length === 1 ? 'One game skews this average' : `${f.length} games skew these averages`)}">outlier</a>` : '';
    };
    return `<div class="rk-chips section" role="group" aria-label="Rank by">${chips}</div>
      <div class="card rk-card"><div class="table-wrap"><table class="rk-table">
        <thead><tr><th class="num">#</th><th>Team</th><th class="num">G</th>${conf.cols
          .map((k) => `<th class="num${k === sortKey ? ' rk-sorted' : ''}"><button class="rk-th" data-rk-sort="${k}" title="${esc(metrics[k].label)}">${esc(metrics[k].short)}</button></th>`)
          .join('')}</tr></thead>
        <tbody>${rows
          .map(
            (row) => `<tr><td class="num rk-pos">${row.ranks[sortKey] ?? '—'}</td><td class="rk-name">${teamCell(row.abbr, ctx, flagChip(row.abbr))}</td><td class="num muted">${row.games}</td>${conf.cols
              .map((k) => `<td class="num ${tone(row.ranks[k])}${k === sortKey ? ' rk-sorted' : ''}"><span class="rk-v">${rkValue(metrics[k], row)}</span><span class="rk-r">${row.ranks[k] ? ordinal(row.ranks[k]) : ''}</span></td>`)
              .join('')}</tr>`
          )
          .join('')}</tbody></table></div></div>
      <p class="muted small" style="margin-top:12px">${note ? note + ' ' : ''}Green marks a top-8 rank and red a bottom-8 rank. Defense numbers are what opponents gained against that team.</p>`;
  }

  function outlierSentence(o, d) {
    const team = nflName(o.team);
    const opp = nflName(o.opp);
    const side = o.side === 'def' ? 'defense' : 'offense';
    const verb = { 'points allowed': 'allowed', 'yards allowed': 'allowed', 'points scored': 'scored', 'yards gained': 'gained' }[o.what];
    const unit = o.unit;
    const range = o.value < o.others.min ? `at least ${o.others.min} in every other game` : `no more than ${o.others.max} in any other game`;
    const oppKey = { 'def.points': 'off.points', 'def.yards': 'off.yards', 'off.points': 'def.points', 'off.yards': 'def.yards' }[o.metric];
    const oppRow = d.teams.find((t) => t.abbr === o.opp);
    const oppRank = oppRow && oppRow.ranks[oppKey];
    const oppNote = oppRank
      ? ` ${esc(opp)}${/s$/.test(opp) ? '’' : '’s'} ${o.side === 'def' ? 'offense' : 'defense'} ranks ${ordinal(oppRank)} in ${o.side === 'def' ? (o.unit === 'points' ? 'scoring' : 'yards') : o.unit === 'points' ? 'points allowed' : 'yards allowed'}.`
      : '';
    const fmtAvg = (v) => (unit === 'yards' ? v.toFixed(0) : v.toFixed(1));
    return {
      title: `${team} ${side}: ${o.value} ${unit} ${verb} ${o.home ? 'vs' : 'at'} ${o.opp}`,
      body: `${esc(team)} ${verb} ${o.value} ${unit} ${o.home ? 'against' : 'at'} ${esc(opp)} on ${fmtDate(o.date)}, and ${range} (${plural(o.others.count, 'other game')}).${oppNote}`,
      effect:
        `Season average ${fmtAvg(o.avg)} per game, ${fmtAvg(o.avgWithout)} without that game. Rank ${ordinal(o.rankNow)} → ${ordinal(o.rankWithout)} in ${o.what}.` +
        (o.also || []).map((a) => ` Same game, ${a.what}: ${a.value} (rank ${ordinal(a.rankNow)} → ${ordinal(a.rankWithout)}).`).join(''),
    };
  }

  function outliersHtml(ctx) {
    const { d, params } = ctx;
    const side = ['def', 'off'].includes(params.get('side')) ? params.get('side') : '';
    const team = params.get('team') || '';
    const list = d.outliers.filter((o) => (!side || o.side === side) && (!team || o.team === team));
    const chip = (v, l) => `<button class="chip-btn ${v === side && !team ? 'active' : ''}" data-rk-filter="${v}">${l}</button>`;
    const item = (o) => {
      const t = outlierSentence(o, d);
      return `<li class="rk-out ${o.flatters ? 'flatters' : 'drags'}">
        <div class="rk-out-tag">${o.flatters ? 'Average looks better than usual' : 'Average looks worse than usual'}</div>
        <div class="rk-out-title">${esc(t.title)}</div>
        <p>${t.body}</p>
        <p class="rk-out-effect">${t.effect}</p>
        <div class="btn-row"><a class="btn sm" href="#/team/NFL/${encodeURIComponent(o.team)}">${esc(nflName(o.team))} page</a></div></li>`;
    };
    return `<div class="rk-chips section">${chip('', 'All')}${chip('def', 'Defense')}${chip('off', 'Offense')}${team ? `<span class="chip">${esc(nflName(team))} <a href="#/rankings?view=outliers" aria-label="Show all teams" style="margin-left:6px">×</a></span>` : ''}</div>
      <p class="muted" style="max-width:70ch">Games that sit far from a team's other results and move its season average. A defense that allowed 3 points once but 28+ every other week looks better on paper than it plays. Check who the opponent was, and whether starters, weather or a blowout explain it.</p>
      ${list.length ? `<ul class="rk-outs">${list.map(item).join('')}</ul>` : `<div class="card empty">${d.games < 40 ? 'Not enough games yet. Outliers show up once teams have played 4 games.' : 'No games stand out right now.'}</div>`}`;
  }

  function renderNotes(_, params) {
    const q = (params.get('q') || '').toLowerCase();
    const tag = params.get('tag') || '';
    const allTags = [...new Set(state.notes.flatMap((n) => n.tags || []))].sort();
    const notes = state.notes
      .filter((n) => !tag || (n.tags || []).includes(tag))
      .filter((n) => !q || `${n.title} ${n.body} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

    // Notes attached to bets and teams, as one feed
    const attached = [
      ...state.bets.flatMap((b) => (b.notes || []).map((n) => ({ ...n, where: betTitle(b), href: '#/bet/' + encodeURIComponent(b.id), kind: 'Bet' }))),
      ...state.teamNotes.flatMap((t) => {
        const [sport, abbr] = t.id.split('-');
        return (t.entries || []).map((n) => ({ ...n, where: teamName(sport, abbr), href: `#/team/${sport}/${encodeURIComponent(abbr)}`, kind: 'Team' }));
      }),
    ]
      .filter((n) => !q || `${n.text} ${n.where}`.toLowerCase().includes(q))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));

    app.innerHTML = `
      <div class="page-head"><div><h1>Notes</h1><div class="muted">General notes, plus every note you've left on bets and teams.</div></div>
        <button class="btn primary" id="newNote">+ New note</button></div>
      <form class="filters" id="noteFilters">
        <input type="search" name="q" placeholder="Search all notes…" value="${esc(params.get('q') || '')}">
        ${allTags.length ? `<select name="tag"><option value="">All tags</option>${allTags.map((t) => `<option ${t === tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
      </form>
      <h2>General notes</h2>
      ${notes.length ? `<div class="note-grid">${notes
        .map(
          (n) => `<div class="note ${n.pinned ? 'pinned' : ''}">
            <div class="note-head"><span class="note-title">${n.pinned ? '📌 ' : ''}${esc(n.title || 'Untitled')}</span>
              <span class="btn-row"><button class="btn sm" data-edit="${esc(n.id)}">Edit</button><button class="btn sm danger" data-del="${esc(n.id)}">Delete</button></span></div>
            <div class="note-body">${esc(n.body)}</div>
            <div class="note-meta" style="margin-top:6px">${(n.tags || []).map((t) => `<a class="chip" href="#/notes?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ')} ${fmtDateTime(n.updatedAt)}</div>
          </div>`
        )
        .join('')}</div>` : `<div class="card empty">${state.notes.length ? 'No notes match.' : 'No general notes yet — jot down strategy, bankroll rules, trends to watch…'}</div>`}
      <h2 class="section" style="margin-top:28px">Notes on bets & teams <span class="muted small">(${attached.length})</span></h2>
      ${attached.length ? `<div class="note-list">${attached
        .slice(0, 100)
        .map(
          (n) => `<div class="note"><div class="note-head"><span><span class="chip">${n.kind}</span> <a href="${esc(n.href)}">${esc(n.where)}</a></span><span class="note-meta">${fmtDateTime(n.at)}</span></div><div class="note-body">${esc(n.text)}</div></div>`
        )
        .join('')}</div>` : '<div class="card empty">Notes you add on a bet or team page show up here.</div>'}`;

    document.getElementById('newNote').addEventListener('click', () => openNoteForm());
    app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openNoteForm(state.notes.find((n) => n.id === b.dataset.edit))));
    app.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Delete this note?')) return;
        await api('DELETE', '/api/notes/' + encodeURIComponent(b.dataset.del));
        state.notes = state.notes.filter((n) => n.id !== b.dataset.del);
        render();
      })
    );
    const form = document.getElementById('noteFilters');
    const apply = () => {
      const p = new URLSearchParams();
      for (const [k, v] of new FormData(form)) if (v) p.set(k, v);
      history.replaceState(null, '', '#/notes' + (p.toString() ? '?' + p : ''));
      const focusQ = document.activeElement && document.activeElement.name === 'q';
      render();
      if (focusQ) {
        const i = app.querySelector('input[name=q]');
        i.focus();
        i.setSelectionRange(i.value.length, i.value.length);
      }
    };
    form.addEventListener('change', apply);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      apply();
    });
    let t;
    form.q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(apply, 250);
    });
  }

  function openNoteForm(note) {
    const n = note || {};
    modalForm.innerHTML = `
      <h2>${note ? 'Edit note' : 'New note'}</h2>
      <div class="field"><label>Title</label><input name="title" value="${esc(n.title || '')}" placeholder="e.g. Bankroll rules"></div>
      <div class="field"><label>Note</label><textarea name="body" rows="10" required>${esc(n.body || '')}</textarea></div>
      <div class="field"><label>Tags</label><input name="tags" value="${esc((n.tags || []).join(', '))}" placeholder="comma separated, e.g. strategy, NFL"></div>
      <label class="btn-row" style="color:var(--text)"><input type="checkbox" name="pinned" ${n.pinned ? 'checked' : ''} style="width:auto"> Pin to top</label>
      <div class="modal-actions"><button type="button" class="btn" value="cancel" data-close>Cancel</button><button class="btn primary" type="submit">Save note</button></div>`;
    wireModalClose();
    modalForm.onsubmit = async (e) => {
      e.preventDefault();
      const f = modalForm;
      await saveNote({
        ...(note || {}),
        title: f.title.value.trim(),
        body: f.body.value,
        tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
        pinned: f.pinned.checked,
      });
      modal.close();
      toast('Note saved');
      render();
    };
    modal.showModal();
  }

  // ---------- settings / backup ----------

  async function renderPhoneCard() {
    const el = document.getElementById('phoneCard');
    let st;
    try {
      st = await api('GET', '/api/auth/status');
    } catch (err) {
      el.innerHTML = `<h2>📱 Phone access</h2><div class="alert error">${esc(err.message)}</div>`;
      return;
    }
    if (!el.isConnected) return;
    if (!st.local) {
      el.innerHTML = `<h2>📱 Phone access</h2><p>You're signed in on this device. Password changes can only be made on the computer running BetsFriend.</p><button class="btn" id="signOut">Sign out of this device</button>`;
      el.querySelector('#signOut').addEventListener('click', async () => {
        await api('POST', '/api/auth/logout');
        location.href = '/login';
      });
      return;
    }
    const wifi = st.urls.filter((u) => u.kind === 'wifi');
    const ts = st.urls.filter((u) => u.kind === 'tailscale');
    const named = st.urls.find((u) => u.kind === 'name');
    const urlList = (list) => list.map((u) => `<code class="phone-url">${esc(u.url)}</code>`).join(' or ');
    el.innerHTML = `<div class="card-head"><h2>📱 Phone access</h2><span class="badge ${st.passwordSet ? 'won' : 'pending'}">${st.passwordSet ? 'On' : 'Off'}</span></div>
      ${st.passwordSet
        ? `<p style="margin-top:0">Other devices can sign in with your password. ${st.sessions ? `${plural(st.sessions, 'device')} signed in.` : ''}</p>
           <ol class="phone-steps">
             <li>Connect your phone to the <strong>same Wi-Fi</strong> as this computer.</li>
             <li>On your phone, open Safari or Chrome and go to ${wifi.length ? urlList(wifi) : named ? urlList([named]) : "this computer's address"}${wifi.length && named ? ` <span class="muted small">(or ${esc(named.url)})</span>` : ''}.</li>
             <li>Enter your password. Then tap <strong>Share → Add to Home Screen</strong> to get a BetsFriend app icon.</li>
           </ol>
           ${ts.length ? `<p class="small">🌍 Away from home (Tailscale): ${urlList(ts)}</p>` : '<p class="muted small">🌍 Want it away from home too? Install the free Tailscale app on this computer and your phone (same account), then reload this page to see a second address that works anywhere.</p>'}
           <p class="muted small">This computer must be on and running BetsFriend (the Terminal window open) for your phone to reach it.</p>`
        : '<p style="margin-top:0">Set a password to use BetsFriend from your phone. Until then, only this computer can open it.</p>'}
      <form id="pwForm" class="form-grid">
        <div class="field"><label>${st.passwordSet ? 'New password' : 'Password'}</label><input name="pw" type="password" minlength="6" autocomplete="new-password" required></div>
        <div class="field"><label>Type it again</label><input name="pw2" type="password" minlength="6" autocomplete="new-password" required></div>
        <div class="full btn-row"><button class="btn primary" type="submit">${st.passwordSet ? 'Change password' : 'Turn on phone access'}</button>
          ${st.passwordSet ? '<button class="btn danger" type="button" id="pwOff">Turn off phone access</button>' : ''}</div>
      </form>`;
    el.querySelector('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.pw.value !== f.pw2.value) return alert("The two passwords don't match.");
      try {
        await api('POST', '/api/auth/password', { password: f.pw.value });
        toast(st.passwordSet ? 'Password changed. Other devices need to sign in again' : 'Phone access is on');
        renderPhoneCard();
      } catch (err) {
        alert(err.message);
      }
    });
    const off = el.querySelector('#pwOff');
    if (off)
      off.addEventListener('click', async () => {
        if (!confirm('Turn off phone access? Other devices will be signed out and blocked.')) return;
        await api('POST', '/api/auth/disable');
        toast('Phone access is off');
        renderPhoneCard();
      });
  }

  function bankrollCardHtml() {
    const s = state.settings || {};
    const z = sizing();
    return `<div class="card" id="bankrollCard"><div class="card-head"><h2>💰 Bankroll & bet sizing</h2>${z ? `<span class="muted small">current bankroll <strong>${money(z.bankroll)}</strong> · 1 unit = <strong>${money(z.unit)}</strong></span>` : ''}</div>
      <p class="muted small" style="margin-top:0">The site suggests bet sizes as a percentage of your bankroll ("units"). Most bettors use 1–2% per bet, so a bad run can't wipe them out.</p>
      <form id="bankrollForm" class="form-grid">
        <div class="field"><label>Starting bankroll ($)</label><input name="bankroll" type="number" min="0" step="1" value="${esc(s.bankroll ?? '')}" placeholder="e.g. 1000"></div>
        <div class="field"><label>Starting date</label><input name="bankrollDate" type="date" value="${esc(s.bankrollDate || today())}"></div>
        <div class="field"><label>1 unit =</label><select name="unitPct">${[0.5, 1, 1.5, 2, 3, 5].map((v) => `<option value="${v}" ${Number(s.unitPct || 1) === v ? 'selected' : ''}>${v}% of bankroll</option>`).join('')}</select></div>
        <div class="field"><label>Warn me above</label><select name="maxPct">${[2, 3, 5, 10].map((v) => `<option value="${v}" ${Number(s.maxPct || 5) === v ? 'selected' : ''}>${v}% of bankroll on one bet</option>`).join('')}</select></div>
        <label class="btn-row full" style="color:var(--text)"><input type="checkbox" name="trackProfit" ${s.trackProfit === false ? '' : 'checked'} style="width:auto"> Add my wins and losses since the starting date to the bankroll automatically</label>
        <div class="full"><button class="btn primary" type="submit">Save bankroll</button></div>
      </form></div>`;
  }

  function updatesCardHtml() {
    const u = state.update;
    const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');
    let status;
    if (state.updateError && !u) status = `<div class="alert error">${esc(state.updateError)}</div>`;
    else if (!u) status = '<div class="muted">Checking for updates…</div>';
    else if (u.upToDate) status = `<div class="alert ok">✅ You're on the latest version.</div>`;
    else if (u.unknown) status = `<div class="alert">This copy doesn't know its version yet. Install the latest once to turn on one-click updates.</div>`;
    else status = `<div class="alert">🎉 A new version is available.</div>`;
    const changes = u && !u.upToDate && u.changes.length
      ? `<h3 style="margin-top:12px">What's new</h3><ul class="changes">${u.changes.map((c) => `<li><strong>${esc(c.message)}</strong> <span class="muted small">${c.date ? fmtDate(c.date.slice(0, 10)) : ''}</span></li>`).join('')}</ul>`
      : '';
    return `<div class="card" id="updatesCard"><div class="card-head"><h2>Updates</h2><span class="muted small">${u ? `checked ${fmtDateTime(u.checkedAt)}` : ''}</span></div>
      ${status}
      <dl class="kv"><dt>Installed version</dt><dd><code>${esc(short(u ? u.installed : state.version && state.version.sha))}</code>${u && u.installedAt ? ` <span class="muted small">installed ${fmtDateTime(u.installedAt)}</span>` : ''}</dd>
        ${u ? `<dt>Latest version</dt><dd><code>${esc(short(u.latest))}</code> <span class="muted small">${u.latestDate ? fmtDateTime(u.latestDate) : ''}</span></dd>` : ''}</dl>
      ${changes}
      <div class="btn-row" style="margin-top:12px">${u && !u.upToDate ? `<button class="btn primary" data-update-now>${u.unknown ? 'Install latest' : 'Update now'}</button>` : ''}<button class="btn" id="checkUpdates">Check for updates</button></div>
      <p class="muted small" style="margin-bottom:0">Updates come from GitHub. Your bets and notes in <code>data/</code> are never changed, and a backup copy is saved in <code>data/backups/</code> before every update.</p></div>`;
  }

  function renderSettings() {
    app.innerHTML = `
      <div class="page-head"><div><h1>Settings & backup</h1><div class="muted">Your data is stored on this computer in <code>data/db.json</code>.</div></div></div>
      <div class="card" id="phoneCard"><h2>📱 Phone access</h2><div class="muted">Loading…</div></div>
      ${bankrollCardHtml()}
      <div class="card" id="oddsKeyCard"><h2>🔑 Odds data</h2>
        <p class="muted small" style="margin-top:0">A free key from <a href="https://the-odds-api.com" target="_blank" rel="noopener">The Odds API</a> adds consensus lines, best prices and player props to the Market tab (500 free requests a month).</p>
        <form id="oddsKeyForm" class="btn-row"><input name="key" type="password" autocomplete="off" placeholder="Paste your Odds API key" value="${esc((state.settings || {}).oddsApiKey || '')}" style="flex:1;min-width:200px"><button class="btn primary" type="submit">Save key</button></form></div>
      <div class="card" id="claudeKeyCard"><h2>📷 Reading bet slip screenshots</h2>
        <p class="muted small" style="margin-top:0">Screenshots are read for free in your browser. For better accuracy (phone photos, parlays, unusual layouts), add a key from the <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Anthropic Console</a> and Claude reads them instead. It costs a few cents per slip, charged to your Anthropic account.</p>
        <form id="claudeKeyForm" class="btn-row"><input name="key" type="password" autocomplete="off" placeholder="Paste your Claude API key (sk-ant-…)" value="${esc((state.settings || {}).claudeApiKey || '')}" style="flex:1;min-width:200px"><button class="btn primary" type="submit">Save key</button></form></div>
      ${updatesCardHtml()}
      <div class="grid cols-2 section">
        <div class="card"><h2>Export</h2><p class="muted">Download everything (bets, notes, team notes) as JSON, or your bets as a CSV spreadsheet.</p>
          <div class="btn-row"><a class="btn primary" href="/api/export" download="betsfriend-backup.json">Download JSON backup</a><button class="btn" id="csvBtn">Download bets CSV</button></div></div>
        <div class="card"><h2>Import</h2><p class="muted">Restore from a JSON backup. <strong>This replaces all current data.</strong></p>
          <input type="file" id="importFile" accept="application/json,.json"></div>
      </div>
      <div class="card section"><h2>Stats</h2><dl class="kv">
        <dt>Bets</dt><dd>${state.bets.length}</dd><dt>General notes</dt><dd>${state.notes.length}</dd>
        <dt>Bet notes</dt><dd>${state.bets.reduce((n, b) => n + (b.notes || []).length, 0)}</dd>
        <dt>Team notes</dt><dd>${state.teamNotes.reduce((n, t) => n + (t.entries || []).length, 0)}</dd></dl></div>`;
    document.getElementById('csvBtn').addEventListener('click', downloadCsv);
    renderPhoneCard();
    document.getElementById('oddsKeyForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveSettings({ oddsApiKey: e.target.key.value.trim() });
      state.market = {};
      toast(e.target.key.value.trim() ? 'Odds API key saved' : 'Odds API key removed');
    });
    document.getElementById('claudeKeyForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveSettings({ claudeApiKey: e.target.key.value.trim() });
      toast(e.target.key.value.trim() ? 'Claude key saved' : 'Claude key removed');
    });
    document.getElementById('bankrollForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await saveSettings({ bankroll: f.bankroll.value === '' ? '' : Number(f.bankroll.value), bankrollDate: f.bankrollDate.value, unitPct: Number(f.unitPct.value), maxPct: Number(f.maxPct.value), trackProfit: f.trackProfit.checked });
      toast('Bankroll saved');
      render();
    });
    document.getElementById('checkUpdates').addEventListener('click', async () => {
      state.update = null;
      render();
      await checkForUpdate(true);
      if (parseHash().parts[0] === 'settings') render();
      toast(state.update && state.update.upToDate ? "You're up to date" : state.update ? 'Update available' : 'Could not check for updates');
    });
    app.querySelectorAll('[data-update-now]').forEach((b) => b.addEventListener('click', installUpdate));
    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!confirm(`Replace all data with this backup (${(data.bets || []).length} bets, ${(data.notes || []).length} notes)?`)) return;
        await api('POST', '/api/import', data);
        await loadAll();
        toast('Backup restored');
        render();
      } catch (err) {
        toast('Import failed: ' + err.message);
      }
    });
  }

  function downloadCsv() {
    const cols = ['date', 'sport', 'betType', 'team', 'opponent', 'player', 'propCategory', 'side', 'line', 'pick', 'legs', 'book', 'odds', 'stake', 'result', 'profit', 'notes'];
    const cell = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = state.bets.map((b) =>
      cols
        .map((c) => (c === 'profit' ? S.betProfit(b).toFixed(2) : c === 'notes' ? (b.notes || []).map((n) => n.text).join(' | ') : c === 'pick' ? betTitle(b) : c === 'legs' ? (b.legs || []).map((l) => `${betTitle(l)} [${l.result || 'pending'}]`).join(' | ') : b[c]))
        .map(cell)
        .join(',')
    );
    const blob = new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bets-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- bet form ----------

  function teamOptions(sport, sel) {
    const list = window.LEAGUES[sport];
    if (!list) return null;
    return '<option value="">—</option>' + list.map(([a, n]) => `<option value="${a}" ${a === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }

  function openBetForm(bet, { duplicate } = {}) {
    const b = { sport: 'NFL', betType: 'Moneyline', result: 'pending', date: today(), ...(bet || {}) };
    const editing = !!(bet && bet.id) && !duplicate;
    const sel = (vals, cur) => vals.map((v) => `<option ${v === cur ? 'selected' : ''} value="${esc(v)}">${esc(v || '—')}</option>`).join('');
    const books = [...new Set(state.bets.map((x) => x.book).filter(Boolean))];

    modalForm.innerHTML = `
      <div class="card-head" style="margin-bottom:8px"><h2 style="margin:0">${editing ? 'Edit bet' : duplicate ? 'Duplicate bet' : bet && bet.fromSlip ? 'Check your bet slip' : 'Add a bet'}</h2>
        ${editing || duplicate || (bet && bet.fromSlip) ? '' : '<button type="button" class="btn sm" data-paste-slip>📷 Use a bet slip instead</button>'}</div>
      ${bet && bet.fromSlip ? '<div class="alert small">Filled in from your bet slip. Check everything, especially teams for player props, then save.</div>' : ''}
      <div class="form-grid">
        <div class="field"><label>Date</label><input type="date" name="date" value="${esc(b.date)}" required></div>
        <div class="field"><label>Sport</label><select name="sport">${sel(['NFL', 'NBA', 'Other'], b.sport)}</select></div>
        <div class="field"><label>Bet type</label><select name="betType">${sel(window.BET_TYPES, b.betType)}</select></div>
        <div class="field" data-show="result"><label>Result</label><select name="result">${sel(['pending', 'won', 'lost', 'push'], b.result)}</select></div>
        <div class="field" data-show="team"><label data-team-label>Team picked</label><span data-team-slot></span></div>
        <div class="field" data-show="opponent"><label>Opponent</label><span data-opp-slot></span></div>
        <div class="field" data-show="player"><label>Player</label><input name="player" value="${esc(b.player || '')}" placeholder="e.g. Patrick Mahomes" list="playerList">
          <datalist id="playerList">${[...new Set(state.bets.map((x) => x.player).filter(Boolean))].map((p) => `<option value="${esc(p)}">`).join('')}</datalist></div>
        <div class="field" data-show="prop"><label>Prop category</label><input name="propCategory" value="${esc(b.propCategory || '')}" list="propList" placeholder="e.g. Passing Yards">
          <datalist id="propList"></datalist></div>
        <div class="field" data-show="side"><label>Side</label><select name="side">${sel(window.SIDES, b.side || '')}</select></div>
        <div class="field" data-show="line"><label>Line</label><input name="line" type="number" step="0.5" value="${esc(b.line ?? '')}" placeholder="e.g. -3.5 or 24.5"></div>
        <div class="field full" data-show="player"><button type="button" class="btn sm" id="researchBtn">🔍 Research this prop</button> <span class="muted small">recent games vs your line</span><div id="researchOut"></div></div>
        <div class="field full" data-show="legs">
          <label>Parlay legs</label>
          <div id="legsEditor"></div>
          <button type="button" class="btn" id="addLeg">+ Add leg</button>
          <div class="hint">Give each leg its own result. The parlay's result is worked out from the legs: one losing leg loses it, and a pushed leg drops out. Each leg also counts toward that team's, player's and prop's success rate.</div>
          ${(window.PROP_CATEGORIES ? Object.keys(window.PROP_CATEGORIES) : []).map((sp) => `<datalist id="legProps-${sp}">${window.PROP_CATEGORIES[sp].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`).join('')}
        </div>
        <div class="field full"><label>Pick description <span class="muted">(optional — auto-generated if blank)</span></label>
          <input name="pick" value="${esc(b.pick || '')}" placeholder="e.g. Sunday night special"></div>
        <div class="field"><label data-odds-label>Odds (American)</label><input name="odds" type="number" step="1" value="${esc(b.odds ?? -110)}" required><div class="hint" id="oddsHint">e.g. -110, +150</div></div>
        <div class="field"><label>Stake ($)</label><input name="stake" type="number" step="0.01" min="0" value="${esc(b.stake ?? '')}" required><div id="stakeHelper" class="stake-helper"></div></div>
        <div class="field"><label>Sportsbook</label><input name="book" value="${esc(b.book || '')}" list="bookList" placeholder="e.g. DraftKings">
          <datalist id="bookList">${[...new Set([...books, 'DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'ESPN Bet', 'Fanatics', 'bet365'])].map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div class="field"><label>Actual P/L override ($)</label><input name="profitOverride" type="number" step="0.01" value="${esc(b.profitOverride ?? '')}" placeholder="optional"><div class="hint">For cash-outs, boosts, free bets</div></div>
        ${editing ? '' : '<div class="field full"><label>Note</label><textarea name="note" rows="3" placeholder="Why this pick? (you can add more notes later)"></textarea></div>'}
      </div>
      <div class="muted small" id="toWin"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Add bet'}</button></div>`;
    wireModalClose();
    const pasteBtn = modalForm.querySelector('[data-paste-slip]');
    if (pasteBtn) pasteBtn.addEventListener('click', () => openSlipImport());

    const f = modalForm;
    const teamSlot = f.querySelector('[data-team-slot]');
    const oppSlot = f.querySelector('[data-opp-slot]');
    let team = b.team || '', opp = b.opponent || '';
    const LEG_TYPES = ['Moneyline', 'Spread', 'Total', 'Player Prop', 'Game Prop', 'Other'];
    const newLeg = () => ({ id: uid(), sport: f.sport.value === 'Other' ? 'NFL' : f.sport.value, betType: 'Moneyline', result: 'pending' });
    let legs = (b.legs || []).map((l) => ({ ...l }));
    let oddsTouched = !!(bet && bet.odds !== undefined && (editing || legs.length));
    const isParlay = () => f.betType.value === 'Parlay';
    const legShow = (l) => {
      const prop = window.PROP_TYPES.includes(l.betType);
      return { player: l.betType === 'Player Prop', prop, side: prop || l.betType === 'Total', line: ['Spread', 'Total', 'Player Prop', 'Game Prop'].includes(l.betType) };
    };
    const legsEl = f.querySelector('#legsEditor');
    const renderLegs = () => {
      legsEl.innerHTML = legs
        .map((l, i) => {
          const sh = legShow(l);
          const tOpts = teamOptions(l.sport, l.team);
          const oOpts = teamOptions(l.sport, l.opponent);
          const fld = (label, html, show = true) => (show ? `<div class="field"><label>${label}</label>${html}</div>` : '');
          return `<div class="leg-card" data-i="${i}">
            <div class="leg-head"><strong>Leg ${i + 1}</strong><span class="muted small leg-preview">${esc(betTitle(l))}</span>
              <button type="button" class="btn sm danger" data-remove-leg="${i}">Remove</button></div>
            <div class="leg-grid">
              ${fld('Sport', `<select data-k="sport">${sel(['NFL', 'NBA', 'Other'], l.sport)}</select>`)}
              ${fld('Type', `<select data-k="betType">${sel(LEG_TYPES, l.betType)}</select>`)}
              ${fld(l.betType === 'Player Prop' ? "Player's team" : 'Team', tOpts ? `<select data-k="team">${tOpts}</select>` : `<input data-k="team" value="${esc(l.team || '')}" placeholder="Team">`)}
              ${fld('Opponent', oOpts ? `<select data-k="opponent">${oOpts}</select>` : `<input data-k="opponent" value="${esc(l.opponent || '')}" placeholder="Opponent">`)}
              ${fld('Player', `<input data-k="player" value="${esc(l.player || '')}" placeholder="e.g. Josh Allen" list="playerList">`, sh.player)}
              ${fld('Prop category', `<input data-k="propCategory" value="${esc(l.propCategory || '')}" list="legProps-${esc(l.sport in window.PROP_CATEGORIES ? l.sport : 'Other')}" placeholder="e.g. Rushing Yards">`, sh.prop)}
              ${fld('Side', `<select data-k="side">${sel(window.SIDES, l.side || '')}</select>`, sh.side)}
              ${fld('Line', `<input data-k="line" type="number" step="0.5" value="${esc(l.line ?? '')}" placeholder="e.g. -3.5">`, sh.line)}
              ${fld('Odds <span class="muted">(optional)</span>', `<input data-k="odds" type="number" step="1" value="${esc(l.odds ?? '')}" placeholder="e.g. -110">`)}
              ${fld('Result', `<select data-k="result">${sel(['pending', 'won', 'lost', 'push'], l.result || 'pending')}</select>`)}
            </div>${sh.player ? `<div class="leg-research"><button type="button" class="btn sm" data-leg-research="${i}">🔍 Research this leg</button><div class="leg-research-out"></div></div>` : ''}</div>`;
        })
        .join('');
      updateParlay();
    };
    const updateParlay = () => {
      if (!isParlay()) return;
      const combined = S.parlayOdds(legs);
      const hint = f.querySelector('#oddsHint');
      if (combined != null && !oddsTouched) f.odds.value = combined;
      hint.innerHTML =
        combined != null
          ? `Combined leg odds: <strong>${oddsStr(combined)}</strong>${String(combined) !== f.odds.value ? ' <button type="button" class="btn sm" id="useLegOdds">Use</button>' : ''} <span class="muted">(change it if your book paid differently, e.g. a boost)</span>`
          : legs.length
          ? 'Enter the parlay odds from your ticket, or fill in each leg\'s odds to calculate them.'
          : 'e.g. +260';
      const use = hint.querySelector('#useLegOdds');
      if (use) use.addEventListener('click', () => { f.odds.value = combined; oddsTouched = false; updateParlay(); });
      f.querySelector('[data-show="result"]').hidden = legs.length > 0;
      updateToWin();
    };
    legsEl.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      const card = e.target.closest('[data-i]');
      if (!k || !card) return;
      const l = legs[Number(card.dataset.i)];
      l[k] = e.target.value;
      if (k === 'sport' || k === 'betType') {
        if (k === 'sport') l.team = l.opponent = '';
        renderLegs();
        return;
      }
      card.querySelector('.leg-preview').textContent = betTitle(l);
      updateParlay();
    });
    legsEl.addEventListener('click', (e) => {
      const rb = e.target.closest('[data-leg-research]');
      if (rb) {
        const l = legs[Number(rb.dataset.legResearch)];
        showResearch(rb.nextElementSibling, { sport: l.sport, team: l.team, player: (l.player || '').trim(), prop: (l.propCategory || '').trim(), line: l.line, side: l.side, opp: l.opponent });
        return;
      }
      const rm = e.target.closest('[data-remove-leg]');
      if (!rm) return;
      legs.splice(Number(rm.dataset.removeLeg), 1);
      renderLegs();
    });
    f.querySelector('#addLeg').addEventListener('click', () => {
      legs.push(newLeg());
      renderLegs();
      const cards = legsEl.querySelectorAll('.leg-card');
      cards[cards.length - 1].scrollIntoView({ block: 'nearest' });
    });

    const sync = () => {
      const sport = f.sport.value;
      const type = f.betType.value;
      const prop = window.PROP_TYPES.includes(type);
      const tOpts = teamOptions(sport, team);
      teamSlot.innerHTML = tOpts ? `<select name="team">${tOpts}</select>` : `<input name="team" value="${esc(team)}" placeholder="Team">`;
      const oOpts = teamOptions(sport, opp);
      oppSlot.innerHTML = oOpts ? `<select name="opponent">${oOpts}</select>` : `<input name="opponent" value="${esc(opp)}" placeholder="Opponent">`;
      f.team.addEventListener('change', () => (team = f.team.value));
      f.opponent.addEventListener('change', () => (opp = f.opponent.value));
      f.querySelector('[data-team-label]').textContent = type === 'Player Prop' ? "Player's team" : type === 'Total' || type === 'Game Prop' ? 'Team / game' : 'Team picked';
      const show = { team: type !== 'Parlay', opponent: !['Parlay', 'Future'].includes(type), player: type === 'Player Prop', prop, side: prop || type === 'Total', line: ['Spread', 'Total', 'Player Prop', 'Game Prop'].includes(type), legs: type === 'Parlay', result: !(type === 'Parlay' && legs.length) };
      f.querySelectorAll('[data-show]').forEach((el) => (el.hidden = !show[el.dataset.show]));
      f.querySelector('[data-odds-label]').textContent = type === 'Parlay' ? 'Parlay odds (American)' : 'Odds (American)';
      if (type === 'Parlay') {
        if (!legs.length) legs.push(newLeg(), newLeg());
        renderLegs();
      } else {
        f.querySelector('#oddsHint').textContent = 'e.g. -110, +150';
      }
      f.querySelector('#propList').innerHTML = (window.PROP_CATEGORIES[sport] || window.PROP_CATEGORIES.Other).map((c) => `<option value="${esc(c)}">`).join('');
      updateToWin();
    };
    const stakeHelper = f.querySelector('#stakeHelper');
    let winChance = '';
    const renderStakeHelper = () => {
      const z = sizing();
      if (!z) {
        stakeHelper.innerHTML = '<a href="#/settings" data-close-modal>Set your bankroll</a> to get suggested bet sizes.';
        return;
      }
      const stake = Number(f.stake.value) || 0;
      const kelly = winChance ? S.kellyFraction(f.odds.value, Number(winChance) / 100) : null;
      const quarterKelly = kelly != null ? Math.round(z.bankroll * kelly * 25) / 100 : null;
      const tooBig = stake > z.bankroll * z.maxPct / 100;
      stakeHelper.innerHTML = `
        <div>1 unit = <strong>${money(z.unit)}</strong> <span class="muted">(${z.unitPct}% of ${money(z.bankroll)})</span></div>
        <div class="btn-row unit-btns">${[0.5, 1, 2, 3].map((u) => `<button type="button" class="btn sm" data-units="${u}">${u}u · ${money(z.unit * u)}</button>`).join('')}</div>
        ${isParlay() ? '<div class="muted">Parlays hit less often, so many bettors keep them to 0.25–0.5 units.</div>' : ''}
        <div class="kelly-row">If you think this wins <input type="number" min="1" max="99" step="1" data-win-chance value="${esc(winChance)}" placeholder="%"> % of the time →
          ${kelly == null ? '<span class="muted">enter a % for a Kelly-based size</span>' : kelly <= 0 ? '<span class="neg">no edge at these odds; consider passing</span>' : `¼-Kelly suggests <strong>${money(quarterKelly)}</strong> <button type="button" class="btn sm" data-use-kelly="${quarterKelly}">Use</button>`}</div>
        ${tooBig ? `<div class="alert small" style="margin:6px 0 0">⚠️ This is ${((stake / z.bankroll) * 100).toFixed(1)}% of your bankroll, above your ${z.maxPct}% limit.</div>` : ''}`;
      stakeHelper.querySelectorAll('[data-units]').forEach((btn) =>
        btn.addEventListener('click', () => {
          f.stake.value = (Math.round(z.unit * Number(btn.dataset.units) * 100) / 100).toFixed(2);
          updateToWin();
        })
      );
      const use = stakeHelper.querySelector('[data-use-kelly]');
      if (use) use.addEventListener('click', () => ((f.stake.value = Number(use.dataset.useKelly).toFixed(2)), updateToWin()));
      const wc = stakeHelper.querySelector('[data-win-chance]');
      wc.addEventListener('change', () => {
        winChance = wc.value;
        renderStakeHelper();
      });
      const link = stakeHelper.querySelector('[data-close-modal]');
      if (link) link.addEventListener('click', () => modal.close());
    };
    const updateToWin = () => {
      renderStakeHelper();
      const win = S.winProfit(f.odds.value, f.stake.value);
      const imp = S.impliedProbability(f.odds.value);
      document.getElementById('toWin').textContent = win ? `To win ${money(win)} (payout ${money(win + Number(f.stake.value))})${imp != null ? ` · implied probability ${pct(imp)}` : ''}` : '';
    };
    f.sport.addEventListener('change', () => {
      team = opp = '';
      sync();
    });
    f.querySelector('#researchBtn').addEventListener('click', () =>
      showResearch(f.querySelector('#researchOut'), { sport: f.sport.value, team: f.team.value, player: f.player.value.trim(), prop: f.propCategory.value.trim(), line: f.line.value, side: f.side.value, opp: f.opponent.value })
    );
    f.betType.addEventListener('change', sync);
    f.odds.addEventListener('input', () => {
      oddsTouched = true;
      updateParlay();
      updateToWin();
    });
    f.stake.addEventListener('input', updateToWin);
    sync();

    f.onsubmit = async (e) => {
      e.preventDefault();
      const odds = Number(f.odds.value);
      if (Math.abs(odds) < 100) {
        alert('American odds must be +100 or higher, or -100 or lower (e.g. -110, +150).');
        return;
      }
      const type = f.betType.value;
      const visible = (name) => !f.querySelector(`[data-show="${name}"]`).hidden;
      let cleanLegs = [];
      if (type === 'Parlay') {
        for (const [i, l] of legs.entries()) {
          if (l.odds !== '' && l.odds != null && Math.abs(Number(l.odds)) < 100) {
            alert(`Leg ${i + 1}: odds must be +100 or higher, or -100 or lower (or leave them blank).`);
            return;
          }
        }
        cleanLegs = legs.map((l) => {
          const sh = legShow(l);
          return {
            id: l.id || uid(),
            sport: l.sport,
            betType: l.betType,
            team: (l.team || '').trim(),
            opponent: (l.opponent || '').trim(),
            player: sh.player ? (l.player || '').trim() : '',
            propCategory: sh.prop ? (l.propCategory || '').trim() : '',
            side: sh.side ? l.side || '' : '',
            line: sh.line && l.line !== '' && l.line != null ? Number(l.line) : '',
            odds: l.odds !== '' && l.odds != null ? Number(l.odds) : '',
            result: l.result || 'pending',
          };
        });
      }
      const data = {
        ...(editing ? bet : {}),
        date: f.date.value,
        sport: f.sport.value,
        betType: type,
        result: cleanLegs.length ? S.parlayResult(cleanLegs) : f.result.value,
        legs: cleanLegs,
        team: visible('team') ? f.team.value.trim() : '',
        opponent: visible('opponent') ? f.opponent.value.trim() : '',
        player: visible('player') ? f.player.value.trim() : '',
        propCategory: visible('prop') ? f.propCategory.value.trim() : '',
        side: visible('side') ? f.side.value : '',
        line: visible('line') && f.line.value !== '' ? Number(f.line.value) : '',
        pick: f.pick.value.trim(),
        odds,
        stake: Number(f.stake.value),
        book: f.book.value.trim(),
        profitOverride: f.profitOverride.value === '' ? '' : Number(f.profitOverride.value),
      };
      if (!editing) {
        const note = f.note.value.trim();
        data.notes = note ? [{ id: uid(), text: note, at: new Date().toISOString() }] : [];
      }
      try {
        const saved = await saveBet(data);
        modal.close();
        toast(editing ? 'Bet updated' : 'Bet added');
        if (!editing) location.hash = '#/bet/' + encodeURIComponent(saved.id);
        else render();
      } catch (err) {
        alert(err.message);
      }
    };
    modal.showModal();
  }

  function wireModalClose() {
    modalForm.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => modal.close()));
  }
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  document.getElementById('addBetBtn').addEventListener('click', () => openBetForm());

  // ---------- player prop research ----------

  const researchCache = {};
  function loadResearch(q) {
    const params = new URLSearchParams({ team: q.team || '', player: q.player || '', prop: q.prop || '', line: q.line ?? '', side: q.side || '', opp: q.opp || '' });
    const key = `${q.sport}:${params}`;
    if (!researchCache[key]) {
      researchCache[key] = api('GET', `/api/propresearch/${String(q.sport || '').toLowerCase()}?${params}`).catch((err) => {
        delete researchCache[key];
        throw err;
      });
    }
    return researchCache[key];
  }

  function researchHtml(d) {
    const s = d.summary;
    const side = d.side === 'Under' || d.side === 'No' ? d.side : 'Over';
    const played = d.games.filter((g) => !g.dnp).slice().reverse(); // oldest -> newest for the chart
    const max = Math.max(1, d.line || 0, ...played.map((g) => g.value)) * 1.12;
    const bars = played
      .map((g) => `<div class="pr-col" title="${esc(fmtDate(g.date.slice(0, 10)))} ${g.home ? 'vs' : '@'} ${esc(g.opp)}: ${g.value}">
          <div class="pr-bar ${g.result === 'won' ? 'hit' : g.result === 'lost' ? 'miss' : 'push'}" style="height:${Math.max(2, (g.value / max) * 100)}%"><span>${g.value}</span></div>
          <div class="pr-lbl">${g.home ? '' : '@'}${esc(g.opp)}</div></div>`)
      .join('');
    const hitRate = s.hits + s.misses ? s.hits / (s.hits + s.misses) : null;
    const dnps = d.games.filter((g) => g.dnp).length;
    return `<div class="pr">
      <div class="pr-head"><strong>${esc(d.player)}</strong> · ${esc(d.prop)}${d.line != null ? ` · ${esc(side)} ${esc(d.line)}` : ''}</div>
      ${d.line != null ? `<div class="pr-stat ${hitRate == null ? '' : hitRate >= 0.6 ? 'pos' : hitRate <= 0.4 ? 'neg' : ''}">${esc(side)} ${esc(d.line)} hit in <strong>${s.hits} of ${s.hits + s.misses + s.pushes}</strong> recent games${hitRate != null ? ` (${pct(hitRate)})` : ''}${s.pushes ? `, ${s.pushes} push` : ''}</div>` : ''}
      <div class="muted small">Average <strong>${s.avg ?? '—'}</strong> · median ${s.median ?? '—'} · high ${s.high ?? '—'} · low ${s.low ?? '—'}${dnps ? ` · missed ${plural(dnps, 'game')}` : ''}</div>
      ${played.length ? `<div class="pr-chart" role="img" aria-label="${esc(d.player)} ${esc(d.prop)} in his last ${played.length} games: ${played.map((g) => g.value).join(', ')}">
        ${d.line != null ? `<div class="pr-line" style="bottom:${18 + (d.line / max) * 105.6}px"><span>${esc(d.line)}</span></div>` : ''}
        ${bars}</div>` : ''}
      ${d.vsOpp.length ? `<div class="small" style="margin-top:6px">vs this opponent: ${d.vsOpp.map((g) => `<strong>${g.value}</strong> <span class="muted">(${esc(fmtDate(g.date.slice(0, 10)))})</span>`).join(', ')}</div>` : ''}
      <div class="muted small" style="margin-top:4px">Last ${plural(played.length, 'game')} played, oldest to newest. Source: ESPN box scores.</div></div>`;
  }

  async function showResearch(el, q) {
    el.innerHTML = '<div class="muted small">Looking up recent games… (first time can take ~15 seconds)</div>';
    try {
      el.innerHTML = researchHtml(await loadResearch(q));
    } catch (err) {
      el.innerHTML = `<div class="alert small">${esc(err.message)}</div>`;
    }
  }

  // ---------- bet slip import ----------

  // Free text recognition for screenshots, loaded from a CDN the first time it's needed.
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
  let ocrWorker = null;
  function loadOcr() {
    if (!ocrWorker) {
      ocrWorker = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TESSERACT_URL;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Couldn't load the text reader. Check the internet connection."));
        document.head.appendChild(s);
      })
        .then(() => window.Tesseract.createWorker('eng'))
        .catch((err) => {
          ocrWorker = null;
          throw err;
        });
    }
    return ocrWorker;
  }

  // Shrink big screenshots before sending them to Claude (keeps uploads fast; text stays sharp).
  function imageForClaude(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`${file.name || 'That file'} isn't an image this browser can open.`));
      };
      img.src = url;
    });
  }

  const MAX_SLIP_IMAGES = 4;

  function openSlipImport(text = '') {
    const hasClaude = !!(state.settings || {}).claudeApiKey;
    modalForm.innerHTML = `
      <h2>Add a bet from a slip</h2>
      <p class="muted small" style="margin-top:0">Upload a screenshot of the bet from your sportsbook app, or paste the confirmation text. You'll check everything before it's saved.</p>
      <label class="slip-drop" id="slipDrop">
        <input type="file" id="slipFiles" accept="image/*" multiple>
        <span class="slip-drop-title">Upload screenshots</span>
        <span class="muted small">Tap to choose, drag them here, or paste an image. Up to ${MAX_SLIP_IMAGES} for a long parlay.</span>
      </label>
      <div class="slip-thumbs" id="slipThumbs"></div>
      <div class="slip-reader muted small" id="slipReader">${
        hasClaude
          ? 'Screenshots are read by Claude.'
          : 'Screenshots are read by the free text reader in your browser. For phone photos and tricky layouts, add a Claude key in <a href="#/settings">Settings</a>.'
      }</div>
      <div id="slipPreview"></div>
      <details class="slip-text" ${text ? 'open' : ''}><summary>Or paste the slip text</summary>
        <textarea name="slip" rows="7" placeholder="e.g.
Kansas City Chiefs -3.5  -110
Buffalo Bills @ Kansas City Chiefs
Wager: $55.00   To Win: $50.00">${esc(text)}</textarea></details>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" data-parse>Read slip</button><button type="button" class="btn primary" data-continue disabled>Continue to bet form</button></div>`;
    modalForm.onsubmit = (e) => e.preventDefault();
    wireModalClose();
    if (!modal.open) modal.showModal();

    let parsed = null;
    let files = [];
    let busy = false;
    const preview = modalForm.querySelector('#slipPreview');
    const go = modalForm.querySelector('[data-continue]');
    const readBtn = modalForm.querySelector('[data-parse]');
    const thumbs = modalForm.querySelector('#slipThumbs');
    const drop = modalForm.querySelector('#slipDrop');
    const textBox = modalForm.querySelector('.slip-text');

    const showParsed = (p, note) => {
      parsed = p;
      const bet = window.BetSlip.slipToBet(parsed);
      const row = (k, v) => (v === '' || v == null ? '' : `<dt>${k}</dt><dd>${v}</dd>`);
      const legLine = (l) => `<li>${esc(betTitle({ ...l, sport: l.sport || bet.sport }))} <span class="muted small">${esc([l.betType, l.odds != null && l.odds !== '' ? oddsStr(l.odds) : '', l.game || ''].filter(Boolean).join(' · '))}</span></li>`;
      preview.innerHTML = `<div class="slip-preview">
        ${note ? `<div class="muted small" style="margin-bottom:6px">${note}</div>` : ''}
        <dl class="kv">${row('Bet type', esc(parsed.betType || '—'))}${row('Sportsbook', esc(parsed.book || ''))}${row('Odds', parsed.odds != null ? oddsStr(parsed.odds) : '')}${row('Stake', parsed.stake != null ? money(parsed.stake) : '')}${row('To win', parsed.toWin != null ? money(parsed.toWin) : '')}${row('Date', parsed.date ? fmtDate(parsed.date) : '')}</dl>
        ${parsed.legs.length ? `<div style="margin-top:6px"><strong>${parsed.legs.length > 1 ? `${parsed.legs.length} selections` : 'Selection'}</strong><ul class="slip-legs">${(bet.legs || [bet]).map(legLine).join('')}</ul></div>` : ''}
        ${parsed.warnings.map((w) => `<div class="alert small" style="margin:6px 0 0">${esc(w)}</div>`).join('')}</div>`;
      go.disabled = false;
    };
    const showError = (msg, retryFree) => {
      preview.innerHTML = `<div class="alert error" style="margin-top:12px">${esc(msg)}${retryFree ? ' <button type="button" class="btn sm" data-free style="margin-left:6px">Use the free reader instead</button>' : ''}</div>`;
      const b = preview.querySelector('[data-free]');
      if (b) b.addEventListener('click', () => readImages(false));
    };
    const setBusy = (on, msg) => {
      busy = on;
      readBtn.disabled = on;
      drop.classList.toggle('disabled', on);
      if (on) preview.innerHTML = `<div class="slip-busy"><div class="spinner"></div><span>${esc(msg)}</span></div>`;
    };

    const renderThumbs = () => {
      thumbs.innerHTML = files
        .map((f, i) => `<div class="slip-thumb"><img src="${f.url}" alt="Screenshot ${i + 1}"><button type="button" class="slip-thumb-x" data-remove="${i}" aria-label="Remove screenshot ${i + 1}">×</button></div>`)
        .join('');
      thumbs.querySelectorAll('[data-remove]').forEach((b) =>
        b.addEventListener('click', () => {
          const [gone] = files.splice(Number(b.dataset.remove), 1);
          URL.revokeObjectURL(gone.url);
          renderThumbs();
        })
      );
    };
    const addFiles = (list) => {
      const imgs = [...list].filter((f) => f.type.startsWith('image/'));
      if (!imgs.length) return toast('Choose an image file (a screenshot of the bet).');
      const room = MAX_SLIP_IMAGES - files.length;
      if (imgs.length > room) toast(`Up to ${MAX_SLIP_IMAGES} screenshots per slip.`);
      files.push(...imgs.slice(0, Math.max(0, room)).map((file) => ({ file, url: URL.createObjectURL(file) })));
      renderThumbs();
      if (files.length) readImages(hasClaude);
    };

    async function readImages(useClaude) {
      if (!files.length || busy) return;
      try {
        if (useClaude) {
          setBusy(true, 'Claude is reading the slip…');
          const images = await Promise.all(files.map((f) => imageForClaude(f.file)));
          const result = await api('POST', '/api/slip-read', { images });
          setBusy(false);
          showParsed(result);
        } else {
          setBusy(true, 'Loading the text reader…');
          const worker = await loadOcr();
          const texts = [];
          for (let i = 0; i < files.length; i++) {
            preview.querySelector('.slip-busy span').textContent = files.length > 1 ? `Reading screenshot ${i + 1} of ${files.length}…` : 'Reading the screenshot…';
            texts.push((await worker.recognize(files[i].file)).data.text);
          }
          setBusy(false);
          modalForm.slip.value = texts.join('\n');
          textBox.querySelector('summary').textContent = 'Text the reader found';
          showParsed(window.BetSlip.parseSlip(modalForm.slip.value), 'Read by the free text reader. If something is off, open "Text the reader found" below, fix it, and press Read slip.');
        }
      } catch (err) {
        setBusy(false);
        showError(err.message, useClaude);
      }
    }

    const readText = () => {
      if (!modalForm.slip.value.trim()) return;
      showParsed(window.BetSlip.parseSlip(modalForm.slip.value));
    };

    modalForm.querySelector('#slipFiles').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      addFiles(e.dataTransfer.files);
    });
    modalForm.addEventListener('paste', (e) => {
      const imgs = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) {
        e.preventDefault();
        addFiles(imgs);
      } else if (e.target === modalForm.slip) {
        setTimeout(readText, 0);
      }
    });
    readBtn.addEventListener('click', () => {
      const hasText = !!modalForm.slip.value.trim();
      if (hasText && (textBox.open || !files.length)) readText();
      else if (files.length) readImages(hasClaude);
      else toast('Add a screenshot or paste the slip text first.');
    });
    modal.addEventListener('close', () => files.forEach((f) => URL.revokeObjectURL(f.url)), { once: true });
    go.addEventListener('click', () => {
      if (!parsed) readText();
      if (!parsed) return;
      openBetForm({ ...window.BetSlip.slipToBet(parsed), fromSlip: true });
    });
    if (text) {
      modalForm.slip.focus();
      readText();
    }
  }

  // ---------- auto-settle ----------

  const pendingPastPicks = () => {
    const today = new Date().toISOString().slice(0, 10);
    return S.picks(state.bets).filter((x) => (x.result || 'pending') === 'pending' && ['NFL', 'NBA'].includes(x.sport) && x.date && x.date <= today);
  };

  function settleLabel(r) {
    const bet = state.bets.find((b) => b.id === r.betId);
    if (!bet) return null;
    const leg = r.legId ? (bet.legs || []).find((l) => l.id === r.legId) : null;
    return leg ? `${betTitle({ ...leg, sport: leg.sport || bet.sport })} <span class="muted small">(leg of ${esc(betTitle(bet))})</span>` : esc(betTitle(bet));
  }

  async function runAutoSettle({ open, quiet } = {}) {
    if (!pendingPastPicks().length) {
      if (!quiet) toast('No pending bets from past games to check');
      return;
    }
    if (open) {
      modalForm.innerHTML = '<h2>⚡ Auto-settle</h2><div class="empty">Looking up final scores and box scores…</div>';
      modalForm.onsubmit = (e) => e.preventDefault();
      modal.showModal();
    }
    try {
      state.autoSettle = await api('POST', '/api/autosettle');
    } catch (err) {
      if (open) modalForm.innerHTML = `<h2>⚡ Auto-settle</h2><div class="alert error">${esc(err.message)}</div><div class="modal-actions"><button type="button" class="btn" data-close>Close</button></div>`;
      wireModalClose();
      return;
    }
    renderSettleBanner();
    if (open) openSettleReview();
  }

  function renderSettleBanner() {
    const el = document.getElementById('settleBanner');
    const graded = ((state.autoSettle && state.autoSettle.results) || []).filter((r) => r.status === 'graded' && settleLabel(r));
    if (!graded.length || state.settleDismissed) {
      el.hidden = true;
      return;
    }
    el.innerHTML = `<span>✅ <strong>${plural(graded.length, 'pick')}</strong> ${graded.length === 1 ? 'has' : 'have'} final results ready to settle.</span>
      <span class="btn-row"><button class="btn sm primary" data-review>Review & settle</button><button class="btn sm" data-later>Later</button></span>`;
    el.hidden = false;
    el.querySelector('[data-review]').addEventListener('click', openSettleReview);
    el.querySelector('[data-later]').addEventListener('click', () => ((state.settleDismissed = true), renderSettleBanner()));
  }

  function openSettleReview() {
    const results = ((state.autoSettle && state.autoSettle.results) || []).filter((r) => settleLabel(r));
    const graded = results.filter((r) => r.status === 'graded');
    const manual = results.filter((r) => ['review', 'unsupported', 'notFound', 'error'].includes(r.status));
    const waiting = results.filter((r) => r.status === 'pending').length;
    modalForm.innerHTML = `
      <h2>⚡ Auto-settle</h2>
      ${graded.length ? `<p class="muted small" style="margin-top:0">Check the results below, untick anything that looks wrong, then apply.</p>
        <div class="settle-list">${graded
          .map((r, i) => `<label class="settle-item"><input type="checkbox" data-i="${i}" checked style="width:auto">
            <span><span class="settle-title">${settleLabel(r)}</span><span class="sub">${esc(r.detail || '')}</span></span>${badge(r.result)}</label>`)
          .join('')}</div>` : '<div class="muted">No new final results to apply.</div>'}
      ${manual.length ? `<h3 style="margin-top:16px">Needs you</h3><div class="settle-list">${manual
        .map((r) => `<div class="settle-item"><span><span class="settle-title">${settleLabel(r)}</span><span class="sub">${esc(r.reason || '')}</span></span><a class="btn sm" href="#/bet/${encodeURIComponent(r.betId)}" data-close>Open</a></div>`)
        .join('')}</div>` : ''}
      ${waiting ? `<p class="muted small">${plural(waiting, 'pick')} ${waiting === 1 ? 'is' : 'are'} for games that haven't finished yet.</p>` : ''}
      <div class="modal-actions"><button type="button" class="btn" data-close>Close</button>${graded.length ? `<button type="button" class="btn primary" data-apply>Apply ${plural(graded.length, 'result')}</button>` : ''}</div>`;
    modalForm.onsubmit = (e) => e.preventDefault();
    wireModalClose();
    if (!modal.open) modal.showModal();
    const apply = modalForm.querySelector('[data-apply]');
    if (apply) {
      const update = () => {
        const n = modalForm.querySelectorAll('.settle-item input:checked').length;
        apply.textContent = `Apply ${plural(n, 'result')}`;
        apply.disabled = !n;
      };
      modalForm.querySelectorAll('.settle-item input').forEach((c) => c.addEventListener('change', update));
      apply.addEventListener('click', async () => {
        const chosen = [...modalForm.querySelectorAll('.settle-item input:checked')].map((c) => graded[Number(c.dataset.i)]);
        const byBet = new Map();
        for (const r of chosen) byBet.set(r.betId, [...(byBet.get(r.betId) || []), r]);
        try {
          for (const [betId, rs] of byBet) {
            const bet = state.bets.find((b) => b.id === betId);
            if (hasLegs(bet)) {
              const legs = bet.legs.map((l) => {
                const r = rs.find((x) => x.legId === l.id);
                return r ? { ...l, result: r.result } : l;
              });
              await saveBet({ ...bet, legs, result: S.parlayResult(legs) });
            } else {
              await saveBet({ ...bet, result: rs[0].result });
            }
          }
          state.autoSettle.results = state.autoSettle.results.filter((r) => !chosen.includes(r));
          modal.close();
          renderSettleBanner();
          toast(`Settled ${plural(chosen.length, 'pick')}`);
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    }
  }

  // ---------- updates ----------

  const overlay = document.getElementById('overlay');
  function showOverlay(title, html, closable) {
    overlay.querySelector('.overlay-box').innerHTML = `<h2>${esc(title)}</h2><p>${html}</p>${closable ? '<button class="btn" data-close-overlay>Close</button>' : '<div class="spinner"></div>'}`;
    overlay.hidden = false;
    const c = overlay.querySelector('[data-close-overlay]');
    if (c) c.addEventListener('click', () => (overlay.hidden = true));
  }

  async function checkForUpdate(force) {
    try {
      state.update = await api('GET', '/api/update/check' + (force ? '?refresh=1' : ''));
      state.updateError = null;
    } catch (err) {
      state.updateError = err.message;
    }
    renderUpdateBanner();
    return state.update;
  }

  function renderUpdateBanner() {
    const el = document.getElementById('updateBanner');
    const u = state.update;
    if (!u || u.upToDate || state.updateDismissed === u.latest) {
      el.hidden = true;
      return;
    }
    const first = u.changes[0];
    el.innerHTML = u.unknown
      ? `<span>🔄 <strong>Turn on one-click updates:</strong> install the latest version of BetsFriend once. Your bets are kept.</span>
         <span class="btn-row"><button class="btn sm primary" data-update-now>Install latest</button><button class="btn sm" data-update-later>Later</button></span>`
      : `<span>🎉 <strong>New version of BetsFriend available</strong>${first ? `: ${esc(first.message)}${u.changes.length > 1 ? ` <span class="muted">(+${u.changes.length - 1} more)</span>` : ''}` : ''}</span>
         <span class="btn-row"><a class="btn sm" href="#/settings">What's new</a><button class="btn sm primary" data-update-now>Update now</button><button class="btn sm" data-update-later>Later</button></span>`;
    el.hidden = false;
    el.querySelector('[data-update-now]').addEventListener('click', installUpdate);
    el.querySelector('[data-update-later]').addEventListener('click', () => {
      state.updateDismissed = u.latest;
      renderUpdateBanner();
    });
  }

  async function installUpdate() {
    const u = state.update;
    if (!u) return;
    if (!confirm('Install the latest version of BetsFriend now?\n\nYour bets and notes are kept, and a backup copy is saved first.')) return;
    let before = null;
    try {
      before = (await api('GET', '/api/version')).boot;
    } catch {}
    showOverlay('Installing update…', 'Downloading the new version from GitHub. Please keep this tab open.');
    let res;
    try {
      res = await api('POST', '/api/update/apply', { sha: u.latest });
    } catch (err) {
      overlay.hidden = true;
      alert(err.message);
      return;
    }
    if (!res.restarting) {
      showOverlay('Almost done: restart BetsFriend', 'The new version is installed. In Terminal, press <strong>Control + C</strong>, then run <code>npm start</code> again and reload this page. After this one time, updates will restart on their own.', true);
      return;
    }
    showOverlay('Restarting BetsFriend…', 'This only takes a few seconds. The page will reload by itself.');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const v = await api('GET', '/api/version');
        if (v.boot !== before && v.sha === res.sha) {
          location.reload();
          return;
        }
      } catch {
        /* server is restarting */
      }
    }
    showOverlay('Update installed', "BetsFriend didn't come back by itself. In Terminal, press <strong>Control + C</strong>, run <code>npm start</code>, then reload this page.", true);
  }

  // ---------- auto-refresh ----------
  // While the site is open, quietly re-fetch injuries and schedules when they go stale and
  // redraw the page, unless you're in the middle of typing or have a form open.

  const INJURY_REFRESH_MS = 15 * 60 * 1000;
  const SCHEDULE_REFRESH_MS = 10 * 60 * 1000;
  const LIVE_REFRESH_MS = 60 * 1000;
  let pendingRender = false;

  const ageOf = (entry) => (entry && entry.data && entry.data.fetchedAt ? Date.now() - new Date(entry.data.fetchedAt).getTime() : Infinity);

  function userIsBusy() {
    if (modal.open || !overlay.hidden) return true;
    const a = document.activeElement;
    if (a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    const sel = window.getSelection && window.getSelection();
    return !!(sel && String(sel).length);
  }

  function quietRender() {
    if (userIsBusy()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  async function autoRefresh() {
    if (document.hidden) return;
    const view = parseHash().parts[0];
    const jobs = [];
    const stamp = (e) => e && e.data && e.data.fetchedAt;
    if (['injuries', 'matchups', 'team', 'bet'].includes(view)) {
      for (const [league, e] of Object.entries(state.injuries)) {
        if (!e.loading && e.data && ageOf(e) > INJURY_REFRESH_MS) {
          const old = stamp(e);
          jobs.push(loadInjuries(league, 'background').then(() => stamp(state.injuries[league]) !== old));
        }
      }
    }
    if (view === 'matchups') {
      for (const [key, e] of Object.entries(state.schedule)) {
        if (e.loading || !e.data) continue;
        const games = e.data.games || [];
        const hot = games.some((g) => g.state === 'in' || (g.state === 'pre' && new Date(g.date).getTime() <= Date.now()));
        if (ageOf(e) > (hot ? LIVE_REFRESH_MS : SCHEDULE_REFRESH_MS)) {
          const [league, days] = key.split(':');
          const old = stamp(e);
          jobs.push(loadSchedule(league, Number(days), 'background').then(() => stamp(state.schedule[key]) !== old));
        }
      }
    }
    const changed = (await Promise.all(jobs)).some(Boolean);
    if (changed || pendingRender) quietRender();
  }

  setInterval(autoRefresh, 30 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) autoRefresh();
  });
  document.addEventListener('focusout', () => setTimeout(() => pendingRender && quietRender(), 0));

  // ---------- boot ----------

  api('GET', '/api/version')
    .then((v) => (state.version = v))
    .catch(() => {});
  checkForUpdate();
  setInterval(checkForUpdate, 3 * 60 * 60 * 1000);

  loadAll()
    .then(() => {
      render();
      runAutoSettle({ quiet: true });
      setInterval(() => !document.hidden && runAutoSettle({ quiet: true }), 30 * 60 * 1000);
    })
    .catch((err) => {
      app.innerHTML = `<div class="alert error">Could not reach the BetsFriend server: ${esc(err.message)}</div>`;
    });
})();
