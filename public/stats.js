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

  const api = { winProfit, toDecimal, toAmerican, parlayOdds, parlayResult, picks, betProfit, impliedProbability, summarize, groupStats, cumulative, streak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
