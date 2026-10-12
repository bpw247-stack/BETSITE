/* BetSite frontend — vanilla JS single-page app with hash routing. */
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
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  async function loadAll() {
    const [bets, notes, teamNotes] = await Promise.all([api('GET', '/api/bets'), api('GET', '/api/notes'), api('GET', '/api/teamNotes')]);
    Object.assign(state, { bets, notes, teamNotes });
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
    teams: renderTeams,
    team: renderTeamDetail,
    injuries: renderInjuries,
    matchups: renderMatchups,
    notes: renderNotes,
    settings: renderSettings,
  };
  const navFor = { bet: 'bets', team: 'teams' };

  function render() {
    const { parts, params } = parseHash();
    const view = views[parts[0]] ? parts[0] : 'dashboard';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (navFor[view] || view)));
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
          <td>${href ? `<a href="${esc(href)}">${esc(label ? label(g) : g.key)}</a>` : esc(label ? label(g) : g.key)}</td>
          <td class="num">${g.count}${g.legs ? `<span class="sub" title="Parlay legs included">${g.legs} in parlays</span>` : ''}</td>
          <td class="num">${record(g)}</td>
          <td>${meter(g.winRate)}</td>
          <td class="num hide-sm">${money(g.staked)}</td>
          <td class="num">${plHtml(g.profit)}</td>
          <td class="num hide-sm">${roiHtml(g.roi)}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table>
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
          <td><a href="#/bet/${encodeURIComponent(b.id)}">${esc(betTitle(b))}</a>${hasLegs(b) ? `<span class="sub legs-line">${esc(legsSummary(b))}</span>` : ''}<span class="sub">${esc(betSub(b))}<span class="show-sm"> · ${fmtDate(b.date)}</span>${nNotes ? ` · 📝 ${nNotes}` : ''}</span></td>
          <td class="num hide-sm">${oddsStr(b.odds)}</td>
          <td class="num">${money(b.stake)}<span class="sub show-sm-block">${oddsStr(b.odds)}</span></td>
          <td>${badge(b.result)}</td>
          <td class="num">${b.result && b.result !== 'pending' ? plHtml(p) : `<span class="muted" title="To win">${money(S.winProfit(b.odds, b.stake))}</span>`}</td>
          <td>${settleBtns}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table>
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
        <button class="btn primary" data-add-bet>+ Add bet</button></div>
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

  async function loadInjuries(league, force) {
    const cur = state.injuries[league];
    if (cur && cur.loading) return cur.promise;
    if (cur && cur.data && !force) return cur;
    const entry = { loading: true };
    entry.promise = api('GET', `/api/injuries/${league}${force ? '?refresh=1' : ''}`)
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
    if (!entry || entry.loading) {
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
        `<div class="muted small" style="margin-bottom:12px">${total} players on ${teams.length} teams · Source: ESPN · updated ${fmtDateTime(entry.data.fetchedAt)}</div>` +
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
    const entry = { loading: true };
    entry.promise = api('GET', `/api/schedule/${league}?days=${days}${force ? '&refresh=1' : ''}`)
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
    if (!sched || sched.loading) {
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
          if (!inj || inj.loading) return `<div class="muted small">Loading injuries…</div>`;
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
          <div class="game-inj">${injBlock(g.a, g.away)}${injBlock(g.h, g.home)}</div>
          <details class="h2h" data-h2h="${esc(`${league}:${g.a}:${g.h}`)}" data-a="${esc(g.a)}" data-b="${esc(g.h)}" data-ou="${g.overUnder ?? ''}"${state.h2hOpen.has(`${league}:${g.a}:${g.h}`) ? ' open' : ''}>
            <summary>📜 Previous matchups</summary>
            <div class="h2h-body">${state.h2hOpen.has(`${league}:${g.a}:${g.h}`) ? h2hHtml(league, g.a, g.h, g.overUnder) : ''}</div>
          </details>
          ${my.length ? `<div class="game-mybets">📌 You have ${plural(my.length, 'pending pick')} on this game: ${my.map((x) => `<a href="#/bet/${encodeURIComponent((x.parlay || x).id)}">${esc(betTitle(x))}${x.parlay ? ' (parlay leg)' : ''}</a>`).join(', ')}</div>` : ''}
          <div class="btn-row game-actions">
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
        `<div class="muted small" style="margin-top:12px">Source: ESPN · schedule updated ${fmtDateTime(sched.data.fetchedAt)}${inj && inj.data ? ` · injuries updated ${fmtDateTime(inj.data.fetchedAt)}` : ''}</div>`;
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
    app.querySelectorAll('[data-bet-game]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const d = new Date(btn.dataset.date);
        const date = isNaN(d) ? today() : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        openBetForm({ sport, team: btn.dataset.team, opponent: btn.dataset.opp, date });
      })
    );
  }

  // ---------- notes ----------

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

  function renderSettings() {
    app.innerHTML = `
      <div class="page-head"><div><h1>Backup & data</h1><div class="muted">Your data is stored on this server in <code>data/db.json</code>.</div></div></div>
      <div class="grid cols-2">
        <div class="card"><h2>Export</h2><p class="muted">Download everything (bets, notes, team notes) as JSON, or your bets as a CSV spreadsheet.</p>
          <div class="btn-row"><a class="btn primary" href="/api/export" download="betsite-backup.json">Download JSON backup</a><button class="btn" id="csvBtn">Download bets CSV</button></div></div>
        <div class="card"><h2>Import</h2><p class="muted">Restore from a JSON backup. <strong>This replaces all current data.</strong></p>
          <input type="file" id="importFile" accept="application/json,.json"></div>
      </div>
      <div class="card section"><h2>Stats</h2><dl class="kv">
        <dt>Bets</dt><dd>${state.bets.length}</dd><dt>General notes</dt><dd>${state.notes.length}</dd>
        <dt>Bet notes</dt><dd>${state.bets.reduce((n, b) => n + (b.notes || []).length, 0)}</dd>
        <dt>Team notes</dt><dd>${state.teamNotes.reduce((n, t) => n + (t.entries || []).length, 0)}</dd></dl></div>`;
    document.getElementById('csvBtn').addEventListener('click', downloadCsv);
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
      <h2>${editing ? 'Edit bet' : duplicate ? 'Duplicate bet' : 'Add a bet'}</h2>
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
        <div class="field"><label>Stake ($)</label><input name="stake" type="number" step="0.01" min="0" value="${esc(b.stake ?? '')}" required></div>
        <div class="field"><label>Sportsbook</label><input name="book" value="${esc(b.book || '')}" list="bookList" placeholder="e.g. DraftKings">
          <datalist id="bookList">${[...new Set([...books, 'DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'ESPN Bet', 'Fanatics', 'bet365'])].map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div class="field"><label>Actual P/L override ($)</label><input name="profitOverride" type="number" step="0.01" value="${esc(b.profitOverride ?? '')}" placeholder="optional"><div class="hint">For cash-outs, boosts, free bets</div></div>
        ${editing ? '' : '<div class="field full"><label>Note</label><textarea name="note" rows="3" placeholder="Why this pick? (you can add more notes later)"></textarea></div>'}
      </div>
      <div class="muted small" id="toWin"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Add bet'}</button></div>`;
    wireModalClose();

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
            </div></div>`;
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
    const updateToWin = () => {
      const win = S.winProfit(f.odds.value, f.stake.value);
      const imp = S.impliedProbability(f.odds.value);
      document.getElementById('toWin').textContent = win ? `To win ${money(win)} (payout ${money(win + Number(f.stake.value))})${imp != null ? ` · implied probability ${pct(imp)}` : ''}` : '';
    };
    f.sport.addEventListener('change', () => {
      team = opp = '';
      sync();
    });
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

  // ---------- boot ----------

  loadAll()
    .then(render)
    .catch((err) => {
      app.innerHTML = `<div class="alert error">Could not reach the BetSite server: ${esc(err.message)}</div>`;
    });
})();
