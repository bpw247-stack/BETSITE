// Public betting splits parser: reads bet % and money % for many games from pasted text
// (articles like SportsBettingDime's, VSIN / Action Network tables, or your own notes).
// Heuristic: the user reviews the result before saving. Browser (window.BetSplits) + Node.
(function (root) {
  'use strict';

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function teamIndex(leagues) {
    const idx = [];
    for (const sport of Object.keys(leagues || {})) {
      for (const [abbr, name] of leagues[sport]) {
        const nick = name.split(' ').pop();
        const city = name.slice(0, name.length - nick.length).trim();
        idx.push({
          sport,
          abbr,
          re: new RegExp(`\\b(${escRe(name)}|${escRe(nick)})\\b`, 'gi'),
          // city alone ("Kansas City") only counts when it's unambiguous (not "Los Angeles"/"New York")
          cityRe: city && !/^(los angeles|la|new york)$/i.test(city) ? new RegExp(`\\b${escRe(city)}\\b`, 'gi') : null,
          abbrRe: new RegExp(`(^|[\\s(@,])${escRe(abbr)}(?=[\\s),:@]|$)`, 'g'),
        });
      }
    }
    return idx;
  }

  // All team mentions in a line with their positions.
  function mentions(line, idx, sport) {
    const out = [];
    for (const t of idx) {
      if (sport && t.sport !== sport) continue;
      for (const re of [t.re, t.cityRe, t.abbrRe].filter(Boolean)) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) out.push({ abbr: t.abbr, at: m.index + (m[1] && re === t.abbrRe ? m[1].length : 0), end: re.lastIndex });
      }
    }
    // keep the earliest mention per position (full names beat nicknames at the same spot)
    return out.sort((a, b) => a.at - b.at || b.end - a.end).filter((m, i, arr) => !arr.slice(0, i).some((x) => m.at < x.end && m.at >= x.at));
  }

  const PCT = /(\d{1,3}(?:\.\d+)?)\s*%/g;
  const BETS_WORDS = /\b(bets?|tickets?|wagers?|betting public|bettors?)\b/i;
  const MONEY_WORDS = /\b(money|handle|cash|dollars?)\b/i;

  // Parse pasted splits for a list of games: [{ id, home: { abbr }, away: { abbr } }]
  function parseSplits(text, games, leagues, sport) {
    const idx = teamIndex(leagues || (root && root.LEAGUES));
    const lines = String(text || '').replace(/[−–—]/g, '-').replace(/ /g, ' ').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const gameOf = (abbr) => games.find((g) => g.home.abbr === abbr || g.away.abbr === abbr);
    const out = {}; // gameId -> { homeBets, homeMoney, overBets, overMoney }
    const put = (abbr, field, value) => {
      const g = gameOf(abbr);
      if (!g || !(value >= 0 && value <= 100)) return;
      const r = (out[g.id] = out[g.id] || { matchup: `${g.away.abbr} @ ${g.home.abbr}` });
      const home = g.home.abbr === abbr;
      if (r[field] == null) r[field] = Math.round((home ? value : 100 - value) * 10) / 10;
    };
    const putTotal = (g, field, overValue) => {
      if (!g || !(overValue >= 0 && overValue <= 100)) return;
      const r = (out[g.id] = out[g.id] || { matchup: `${g.away.abbr} @ ${g.home.abbr}` });
      if (r[field] == null) r[field] = overValue;
    };

    let header = null; // column order from a header row, e.g. ['money','bets']
    let currentGame = null; // last game a line mentioned (for "the over" sentences)

    for (const line of lines) {
      const ms = mentions(line, idx, sport);
      const pcts = [...line.matchAll(PCT)].map((m) => ({ v: Number(m[1]), at: m.index }));
      if (ms.length) {
        const g = gameOf(ms[0].abbr);
        if (g) currentGame = g;
      }

      // header row: words but no team, e.g. "Team | Spread | Handle | Bets | Total | Handle | Bets"
      if (!ms.length && !pcts.length && (BETS_WORDS.test(line) || MONEY_WORDS.test(line))) {
        const order = [...line.matchAll(/\b(handle|money|cash|bets?|tickets?)\b/gi)].map((m) => (/^(handle|money|cash)$/i.test(m[1]) ? 'money' : 'bets'));
        if (order.length >= 2) header = order;
        continue;
      }
      if (!pcts.length) continue;

      // --- sentence style: "62% of bets are on the Bills", "55% of the money on Kansas City", "70% of tickets on the over"
      let usedSentence = false;
      const clauses = line
        .split(/(?<=[.;!?])\s+|,\s+(?=(?:but|while|and|with)\b)|\s+(?=(?:but|while)\s)/i)
        // "71% of tickets and 66% of the handle": split clauses holding two percentages on "and"
        .flatMap((c) => ([...c.matchAll(PCT)].length > 1 ? c.split(/\s+and\s+/i) : [c]));
      let subject = null; // carried into a follow-on clause without its own subject
      for (const clause of clauses) {
        const p = [...clause.matchAll(PCT)];
        const cm = mentions(clause, idx, sport);
        const over = /\bover\b/i.test(clause) && !/\bunder\b/i.test(clause);
        const under = /\bunder\b/i.test(clause) && !/\bover\b/i.test(clause);
        if (over || under || cm.length) subject = over ? 'over' : under ? 'under' : null;
        if (p.length !== 1) continue;
        const isBets = BETS_WORDS.test(clause), isMoney = MONEY_WORDS.test(clause);
        if (isBets === isMoney) continue; // need exactly one kind
        const field = isMoney ? 'Money' : 'Bets';
        const v = Number(p[0][1]);
        if (over || (!cm.length && subject === 'over')) {
          putTotal(currentGame, `over${field}`, v);
          usedSentence = true;
        } else if (under || (!cm.length && subject === 'under')) {
          putTotal(currentGame, `over${field}`, 100 - v);
          usedSentence = true;
        } else if (cm.length) {
          // the team the percentage is "on": the first team mentioned after the %, else the nearest before it
          const after = cm.find((m) => m.at > p[0].index);
          put((after || cm[cm.length - 1]).abbr, `home${field}`, v);
          usedSentence = true;
        }
      }
      if (usedSentence) continue;

      // --- row style: "Kansas City Chiefs -2.5 55% 38% u46.5 45% 40%" (VSIN-like) or "Bills 62% 45%"
      if (ms.length === 1 && pcts.length >= 2) {
        const order = header || ['bets', 'money'];
        const abbr = ms[0].abbr;
        const g = gameOf(abbr);
        const [a, b] = [pcts[0].v, pcts[1].v];
        put(abbr, 'home' + (order[0] === 'money' ? 'Money' : 'Bets'), a);
        put(abbr, 'home' + (order[1] === 'money' ? 'Money' : 'Bets'), b);
        // a total block: "o46.5 45% 60%" (over) or "u46.5 ..." (under) after the spread percentages
        const tot = /\b([ou])\s?\d+(?:\.\d+)?\b/i.exec(line.slice(pcts[1].at));
        if (tot && pcts.length >= 4) {
          const isOver = tot[1].toLowerCase() === 'o';
          const [c, d] = [pcts[2].v, pcts[3].v];
          const f1 = 'over' + (order[2] === 'money' || (!order[2] && order[0] === 'money') ? 'Money' : 'Bets');
          const f2 = 'over' + (order[3] === 'money' || (!order[3] && order[1] === 'money') ? 'Money' : 'Bets');
          putTotal(g, f1, isOver ? c : 100 - c);
          putTotal(g, f2, isOver ? d : 100 - d);
        }
      }
    }
    return out;
  }

  const api = { parseSplits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetSplits = api;
})(typeof window !== 'undefined' ? window : globalThis);
