// Pure betting math + aggregation. Loaded in the browser (window.BetStats)
// and in Node for tests (module.exports).
(function (root) {
  'use strict';

  const SETTLED = ['won', 'lost', 'push'];

  // Profit (not including returned stake) on a winning bet at American odds.
  function winProfit(odds, stake) {
    odds = Number(odds);
    stake = Number(stake);
    if (!isFinite(odds) || !isFinite(stake) || stake <= 0 || odds === 0 || Math.abs(odds) < 100) return 0;
    return odds > 0 ? stake * (odds / 100) : stake * (100 / Math.abs(odds));
  }

  const validOdds = (o) => o !== '' && o != null && isFinite(Number(o)) && Math.abs(Number(o)) >= 100;

  function toDecimal(odds) {
    odds = Number(odds);
    return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
  }

  function toAmerican(decimal) {
    if (!(decimal > 1)) return null;
    return Math.round(decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1));
  }

  // Combined American odds for a set of legs, or null if any leg is missing odds.
  function parlayOdds(legs) {
    if (!legs || !legs.length || !legs.every((l) => validOdds(l.odds))) return null;
    return toAmerican(legs.reduce((d, l) => d * toDecimal(l.odds), 1));
  }

  // Overall parlay result from its legs: any loss loses; any pending leg keeps it open;
  // pushed legs drop out; all pushed is a push. Null when there are no legs.
  function parlayResult(legs) {
    if (!legs || !legs.length) return null;
    const r = legs.map((l) => l.result || 'pending');
    if (r.includes('lost')) return 'lost';
    if (r.includes('pending')) return 'pending';
    if (r.every((x) => x === 'push')) return 'push';
    return 'won';
  }

  // Net profit/loss for a bet. Pending bets are 0.
  // A numeric `profitOverride` (e.g. cash-outs, boosted payouts) wins over computed value.
  function betProfit(bet) {
    if (!bet || !SETTLED.includes(bet.result)) return 0;
    if (bet.profitOverride !== undefined && bet.profitOverride !== null && bet.profitOverride !== '' && isFinite(Number(bet.profitOverride))) {
      return Number(bet.profitOverride);
    }
    const stake = Number(bet.stake) || 0;
    const legs = bet.legs || [];
    if (bet.result === 'won' && legs.some((l) => l.result === 'push')) {
      // A pushed leg drops out, so the payout shrinks to the remaining legs' odds (when known).
      const reduced = parlayOdds(legs.filter((l) => l.result !== 'push'));
      if (reduced != null) return winProfit(reduced, stake);
    }
    if (bet.result === 'won') return winProfit(bet.odds, stake);
    if (bet.result === 'lost') return -stake;
    return 0;
  }

  // Kelly criterion: fraction of bankroll to stake given your own win probability (0-1).
  // Returns 0 when the bet has no edge at these odds.
  function kellyFraction(odds, winProb) {
    odds = Number(odds);
    const p = Number(winProb);
    if (!isFinite(odds) || Math.abs(odds) < 100 || !(p > 0 && p < 1)) return 0;
    const b = toDecimal(odds) - 1;
    return Math.max(0, (b * p - (1 - p)) / b);
  }

  // Current bankroll: starting amount plus P/L of bets settled on/after the start date.
  function bankrollNow(settings, bets) {
    const start = Number(settings && settings.bankroll);
    if (!(start > 0)) return null;
    if (settings.trackProfit === false) return start;
    const since = settings.bankrollDate || '';
    return start + bets.filter((b) => !since || String(b.date) >= since).reduce((sum, b) => sum + betProfit(b), 0);
  }

  function impliedProbability(odds) {
    odds = Number(odds);
    if (!isFinite(odds) || Math.abs(odds) < 100) return null;
    return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  }

  // Every individual pick: straight bets as themselves, parlays expanded into their legs.
  // Legs inherit the parlay's date/sport and carry `parlay` (the parent bet). They count
  // toward records and success rates but not toward money (the stake belongs to the parlay).
  function picks(bets) {
    const out = [];
    for (const b of bets) {
      if (b.legs && b.legs.length) {
        for (const l of b.legs) out.push({ ...l, sport: l.sport || b.sport, date: b.date, createdAt: b.createdAt, result: l.result || 'pending', parlay: b });
      } else {
        out.push(b);
      }
    }
    return out;
  }

  function summarize(bets) {
    const s = { count: 0, legs: 0, won: 0, lost: 0, push: 0, pending: 0, staked: 0, settledStaked: 0, atRisk: 0, profit: 0, winRate: null, roi: null };
    for (const b of bets) {
      s.count++;
      if (b.parlay) {
        // parlay leg: counts for the record only
        s.legs++;
        if (b.result === 'won') s.won++;
        else if (b.result === 'lost') s.lost++;
        else if (b.result === 'push') s.push++;
        else s.pending++;
        continue;
      }
      const stake = Number(b.stake) || 0;
      s.staked += stake;
      if (b.result === 'won') s.won++;
      else if (b.result === 'lost') s.lost++;
      else if (b.result === 'push') s.push++;
      else {
        s.pending++;
        s.atRisk += stake;
      }
      if (SETTLED.includes(b.result)) s.settledStaked += stake;
      s.profit += betProfit(b);
    }
    const decided = s.won + s.lost;
    s.winRate = decided ? s.won / decided : null;
    s.roi = s.settledStaked ? s.profit / s.settledStaked : null;
    return s;
  }

  // Group bets by key(bet) -> [{ key, bets, ...summary }], sorted by bet count desc.
  // key may return a string, a falsy value (skipped) or an array of keys (bet counted in each).
  function groupStats(bets, key) {
    const groups = new Map();
    for (const b of bets) {
      let k = key(b);
      const keys = Array.isArray(k) ? k : [k];
      for (const one of keys) {
        if (!one) continue;
        if (!groups.has(one)) groups.set(one, []);
        groups.get(one).push(b);
      }
    }
    return [...groups.entries()]
      .map(([k, list]) => ({ key: k, bets: list, ...summarize(list) }))
      .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
  }

  // Running P/L over settled bets ordered by date: [{ date, profit, total, bet }]
  function cumulative(bets) {
    let total = 0;
    return bets
      .filter((b) => SETTLED.includes(b.result))
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((b) => {
        const p = betProfit(b);
        total += p;
        return { date: b.date, profit: p, total, bet: b };
      });
  }

  // Current streak like { type: 'won', length: 3 } (pushes/pending skipped)
  function streak(bets) {
    const decided = cumulative(bets).filter((x) => x.bet.result !== 'push');
    if (!decided.length) return null;
    const type = decided[decided.length - 1].bet.result;
    let length = 0;
    for (let i = decided.length - 1; i >= 0 && decided[i].bet.result === type; i--) length++;
    return { type, length };
  }

  // Rank groups (from groupStats) by how far they sit from a coin flip, weighted by sample size,
  // so 12-3 beats 2-0. Returns { strengths, weaknesses } with at least `min` decided picks each.
  function takeaways(groups, { min = 5, limit = 3 } = {}) {
    const scored = groups
      .filter((g) => g.won + g.lost >= min)
      .map((g) => ({ ...g, score: (g.winRate - 0.5) * Math.sqrt(g.won + g.lost) }));
    return {
      strengths: scored.filter((g) => g.winRate > 0.5).sort((a, b) => b.score - a.score).slice(0, limit),
      weaknesses: scored.filter((g) => g.winRate < 0.5).sort((a, b) => a.score - b.score).slice(0, limit),
    };
  }

  // Odds buckets for "where do you win" breakdowns.
  function oddsBucket(odds) {
    const o = Number(odds);
    if (!isFinite(o) || Math.abs(o) < 100) return null;
    if (o <= -200) return 'Heavy favorite (-200 or shorter)';
    if (o < -100) return 'Favorite (-199 to -101)';
    if (o <= 150) return 'Near even (-100 to +150)';
    if (o <= 300) return 'Underdog (+151 to +300)';
    return 'Long shot (+301 or longer)';
  }

  // Signals from public betting splits (percentages entered by you) and line movement.
  // splits: { homeBets, homeMoney, overBets, overMoney } (0-100, home/over side; the other side is 100 - x)
  // lines: { homeSpreadOpen, homeSpreadNow, totalOpen, totalNow }; names: { home, away }
  function splitsSignals(splits, lines, names) {
    const out = [];
    if (!splits) return out;
    const n = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
    const hb = n(splits.homeBets), hm = n(splits.homeMoney), ob = n(splits.overBets), om = n(splits.overMoney);
    const side = (homeSide) => (homeSide ? names.home : names.away);
    if (hb != null && hm != null) {
      const gap = hm - hb;
      if (Math.abs(gap) >= 15) {
        const home = gap > 0;
        out.push({ type: 'sharp', text: `💰 Bigger bets on ${side(home)}: ${home ? hb : 100 - hb}% of bets but ${home ? hm : 100 - hm}% of the money` });
      }
    }
    if (hb != null && (hb >= 70 || hb <= 30)) out.push({ type: 'public', text: `🐑 ${side(hb >= 70)} is the public side (${hb >= 70 ? hb : 100 - hb}% of spread bets)` });
    const so = n(lines && lines.homeSpreadOpen), sn = n(lines && lines.homeSpreadNow);
    if (hb != null && so != null && sn != null && so !== sn) {
      // books normally move the line against the popular side; moving the other way = reverse line movement
      if (hb >= 60 && sn > so) out.push({ type: 'rlm', text: `↩️ Reverse line movement toward ${names.away}: ${hb}% of bets on ${names.home}, but the line moved ${fmtLine(so)} → ${fmtLine(sn)}` });
      if (hb <= 40 && sn < so) out.push({ type: 'rlm', text: `↩️ Reverse line movement toward ${names.home}: ${100 - hb}% of bets on ${names.away}, but ${names.home} moved ${fmtLine(so)} → ${fmtLine(sn)}` });
    }
    if (ob != null && om != null && Math.abs(om - ob) >= 15) {
      const over = om > ob;
      out.push({ type: 'sharp', text: `💰 Bigger bets on the ${over ? 'over' : 'under'}: ${over ? ob : 100 - ob}% of bets but ${over ? om : 100 - om}% of the money` });
    }
    const to = n(lines && lines.totalOpen), tn = n(lines && lines.totalNow);
    if (ob != null && to != null && tn != null && to !== tn) {
      if (ob >= 60 && tn < to) out.push({ type: 'rlm', text: `↩️ Total dropped ${to} → ${tn} even though ${ob}% of bets are on the over` });
      if (ob <= 40 && tn > to) out.push({ type: 'rlm', text: `↩️ Total rose ${to} → ${tn} even though ${100 - ob}% of bets are on the under` });
    }
    return out;
  }
  const fmtLine = (x) => (x > 0 ? '+' + x : String(x));

  const api = { splitsSignals, takeaways, oddsBucket, kellyFraction, bankrollNow, winProfit, toDecimal, toAmerican, parlayOdds, parlayResult, picks, betProfit, impliedProbability, summarize, groupStats, cumulative, streak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
