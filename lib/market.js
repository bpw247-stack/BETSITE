'use strict';

// Betting-market data:
// - ESPN game lines: current spread/total/moneyline and the opener when ESPN provides it
// - The Odds API (https://the-odds-api.com, free key): lines from many sportsbooks ->
//   consensus (median) + best available price, and player-prop consensus
// Pure parsing/analysis; the server does the fetching and caching.

function num(v) {
  if (v && typeof v === 'object') v = v.value != null ? v.value : v.line != null ? v.line : v.displayValue;
  const n = parseFloat(String(v == null ? '' : v).replace(/^[ou]/i, '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}
const median = (arr) => {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

// Lines from one ESPN scoreboard competition. Spreads are from the HOME team's side.
function parseEspnLines(comp, homeAbbr) {
  const o = (comp && Array.isArray(comp.odds) && comp.odds[0]) || null;
  if (!o) return null;
  const current = { homeSpread: null, total: num(o.overUnder), homeML: num(o.homeTeamOdds && o.homeTeamOdds.moneyLine), awayML: num(o.awayTeamOdds && o.awayTeamOdds.moneyLine) };
  const m = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/i.exec(String(o.details || '').trim());
  if (m) current.homeSpread = m[1].toUpperCase() === homeAbbr ? -Math.abs(Number(m[2])) : Math.abs(Number(m[2]));
  else if (/^(EVEN|PK)/i.test(String(o.details || ''))) current.homeSpread = 0;
  else if (num(o.spread) != null) current.homeSpread = num(o.spread);

  // Newer ESPN payloads carry open/close objects, e.g. pointSpread.home.open.line = "-3.5", total.over.open.line = "o47.5"
  const pick = (...paths) => {
    for (const p of paths) {
      const v = p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
      if (num(v) != null) return num(v);
    }
    return null;
  };
  const open = {
    homeSpread: pick('pointSpread.home.open.line', 'open.pointSpread.home', 'homeTeamOdds.open.pointSpread'),
    total: pick('total.over.open.line', 'open.total', 'open.overUnder'),
    homeML: pick('moneyline.home.open.odds', 'homeTeamOdds.open.moneyLine'),
    awayML: pick('moneyline.away.open.odds', 'awayTeamOdds.open.moneyLine'),
  };
  const close = { homeSpread: pick('pointSpread.home.close.line'), total: pick('total.over.close.line') };
  if (close.homeSpread != null && current.homeSpread == null) current.homeSpread = close.homeSpread;
  if (close.total != null && current.total == null) current.total = close.total;
  return {
    provider: (o.provider && o.provider.name) || '',
    current,
    open: Object.values(open).some((v) => v != null) ? open : null,
  };
}

// ---------- The Odds API ----------

const SPORT_KEYS = { nfl: 'americanfootball_nfl', nba: 'basketball_nba' };
const PROP_MARKETS = {
  nfl: { player_pass_yds: 'Passing Yards', player_pass_tds: 'Passing TDs', player_rush_yds: 'Rushing Yards', player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_anytime_td: 'Anytime TD' },
  nba: { player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: '3-Pointers Made', player_points_rebounds_assists: 'Pts + Reb + Ast' },
};

const nickname = (name) => String(name || '').trim().split(/\s+/).pop().toLowerCase();

// Find the Odds API event for an ESPN game (team nicknames + start time within 12h).
function matchOddsEvent(events, game) {
  const h = nickname(game.home.name), a = nickname(game.away.name);
  const t = Date.parse(game.date);
  return (events || []).find((e) => nickname(e.home_team) === h && nickname(e.away_team) === a && Math.abs(Date.parse(e.commence_time) - t) < 12 * 3600000) || null;
}

// Consensus + best prices for a game from an Odds API event with h2h/spreads/totals markets.
function gameConsensus(ev) {
  if (!ev) return null;
  const rows = [];
  for (const b of ev.bookmakers || []) {
    const row = { book: b.title || b.key };
    for (const mk of b.markets || []) {
      for (const o of mk.outcomes || []) {
        const isHome = o.name === ev.home_team;
        if (mk.key === 'spreads') {
          if (isHome) Object.assign(row, { homeSpread: o.point, homeSpreadPrice: o.price });
          else Object.assign(row, { awaySpread: o.point, awaySpreadPrice: o.price });
        } else if (mk.key === 'totals') {
          if (/^over$/i.test(o.name)) Object.assign(row, { total: o.point, overPrice: o.price });
          else if (/^under$/i.test(o.name)) Object.assign(row, { underTotal: o.point, underPrice: o.price });
        } else if (mk.key === 'h2h') {
          if (isHome) row.homeML = o.price;
          else row.awayML = o.price;
        }
      }
    }
    rows.push(row);
  }
  if (!rows.length) return null;
  const bestBy = (list, better) => list.reduce((best, r) => (!best || better(r, best) ? r : best), null);
  const has = (k) => rows.filter((r) => r[k] != null);
  const best = {
    homeSpread: bestBy(has('homeSpread'), (r, b) => r.homeSpread > b.homeSpread || (r.homeSpread === b.homeSpread && r.homeSpreadPrice > b.homeSpreadPrice)),
    awaySpread: bestBy(has('awaySpread'), (r, b) => r.awaySpread > b.awaySpread || (r.awaySpread === b.awaySpread && r.awaySpreadPrice > b.awaySpreadPrice)),
    over: bestBy(has('total'), (r, b) => r.total < b.total || (r.total === b.total && r.overPrice > b.overPrice)),
    under: bestBy(has('underTotal'), (r, b) => r.underTotal > b.underTotal || (r.underTotal === b.underTotal && r.underPrice > b.underPrice)),
    homeML: bestBy(has('homeML'), (r, b) => r.homeML > b.homeML),
    awayML: bestBy(has('awayML'), (r, b) => r.awayML > b.awayML),
  };
  const pickBest = (r, k, pk) => (r ? { book: r.book, point: r[k], price: pk ? r[pk] : r[k] } : null);
  return {
    books: rows.length,
    consensus: { homeSpread: median(rows.map((r) => r.homeSpread)), total: median(rows.map((r) => r.total)), homeML: median(rows.map((r) => r.homeML)), awayML: median(rows.map((r) => r.awayML)) },
    best: {
      homeSpread: pickBest(best.homeSpread, 'homeSpread', 'homeSpreadPrice'),
      awaySpread: pickBest(best.awaySpread, 'awaySpread', 'awaySpreadPrice'),
      over: pickBest(best.over, 'total', 'overPrice'),
      under: pickBest(best.under, 'underTotal', 'underPrice'),
      homeML: best.homeML ? { book: best.homeML.book, price: best.homeML.homeML } : null,
      awayML: best.awayML ? { book: best.awayML.book, price: best.awayML.awayML } : null,
    },
    rows,
  };
}

// Player props from an Odds API event-odds payload -> [{ player, category, line, books, over:{price,book,point}, under:{...} }]
function propsConsensus(evOdds, league) {
  const markets = PROP_MARKETS[league] || {};
  const map = new Map();
  for (const b of (evOdds && evOdds.bookmakers) || []) {
    for (const mk of b.markets || []) {
      const category = markets[mk.key];
      if (!category) continue;
      for (const o of mk.outcomes || []) {
        const player = o.description || o.participant;
        if (!player) continue;
        const key = `${player}|${category}`;
        const e = map.get(key) || { player, category, quotes: [] };
        e.quotes.push({ book: b.title || b.key, side: /^(over|yes)$/i.test(o.name) ? 'over' : 'under', point: o.point == null ? null : Number(o.point), price: o.price });
        map.set(key, e);
      }
    }
  }
  const out = [];
  for (const e of map.values()) {
    const overs = e.quotes.filter((q) => q.side === 'over');
    const unders = e.quotes.filter((q) => q.side === 'under');
    const line = median(overs.map((q) => q.point));
    const best = (list, betterPoint) =>
      list.reduce((b, q) => (!b || betterPoint(q.point, b.point) || (q.point === b.point && q.price > b.price) ? q : b), null);
    const bo = best(overs, (p, bp) => p != null && bp != null && p < bp);
    const bu = best(unders, (p, bp) => p != null && bp != null && p > bp);
    out.push({
      player: e.player,
      category: e.category,
      line,
      books: new Set(e.quotes.map((q) => q.book)).size,
      over: bo ? { price: bo.price, book: bo.book, point: bo.point } : null,
      under: bu ? { price: bu.price, book: bu.book, point: bu.point } : null,
      yesNo: overs.every((q) => q.point == null),
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || b.books - a.books || a.player.localeCompare(b.player));
}

module.exports = { parseEspnLines, SPORT_KEYS, PROP_MARKETS, matchOddsEvent, gameConsensus, propsConsensus, median };
