'use strict';

// "Advantageous bets" for one game: candidate bets scored from everything the site knows
// (rankings, on-paper score vs the line, betting trends, injuries, weather, odds, prop
// matchups and the user's own record). Each suggestion lists the reasons for and against.
// Pure: the server gathers the inputs.

const Stats = require('../public/stats.js');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ord = (n) => {
  const v = n % 100;
  return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th');
};
const fmtLine = (n) => (n > 0 ? `+${n}` : String(n));
const fmtOdds = (n) => (n == null ? '' : n > 0 ? `+${n}` : String(n));
const BAD_STATUS = /^(out|doubtful|injured reserve|ir|pup|suspended)/i;

// Win/loss from the user's settled picks matching `test`.
function recordOf(picks, test) {
  let w = 0;
  let l = 0;
  for (const p of picks) {
    if (!test(p)) continue;
    if (p.result === 'won') w++;
    else if (p.result === 'lost') l++;
  }
  return { w, l, n: w + l, rate: w + l ? w / (w + l) : null };
}

// A reason from the user's own history, if there's enough of it to matter.
function recordReason(rec, what, min = 5) {
  if (!rec || rec.n < min) return null;
  if (rec.rate >= 0.6) return { dir: 1, weight: rec.n >= 10 ? 0.6 : 0.4, source: 'Your record', text: `You're ${rec.w}-${rec.l} ${what}` };
  if (rec.rate <= 0.4) return { dir: -1, weight: rec.n >= 10 ? 0.6 : 0.4, source: 'Your record', text: `You're ${rec.w}-${rec.l} ${what}` };
  return null;
}

function finish(s) {
  const score = s.reasons.reduce((a, r) => a + r.dir * r.weight, 0);
  const confidence = score >= 2.5 ? 'Strong' : score >= 1.6 ? 'Good' : 'Lean';
  return { ...s, score: Math.round(score * 100) / 100, confidence, for: s.reasons.filter((r) => r.dir > 0), against: s.reasons.filter((r) => r.dir < 0) };
}

function qbsOut(injuries, team) {
  return (injuries[team] || []).filter((p) => /^QB$/i.test(p.position) && BAD_STATUS.test(p.status || ''));
}
function keyOut(injuries, team) {
  return (injuries[team] || []).filter((p) => /^(RB|WR|TE)$/i.test(p.position) && BAD_STATUS.test(p.status || ''));
}

/**
 * game: { sport, home, away, homeSpread (home's line, e.g. -3.5), total, homeML, awayML, best?, indoor }
 * matchup: rankings.gameMatchup(data, { team: away, opp: home }) or null
 * trends: teamTrends() items for both teams (each has .team, .suggest, .score, .text)
 * injuries: { [abbr]: [{ name, position, status }] }
 * weather: weather summary ({ wind, gust, precipChance, roof }) or null
 * bets: the user's bets (db.bets)
 * props: prop lines for this game [{ player, category, line, over, under, yesNo, team, opp, qb }]
 * propNotes: (prop) => rankings.matchupNotes(...) for that prop's opponent, or null
 * streaks: player milestone streaks for these teams [{ player, team, category, text, hits, of, threshold }]
 */
function advise({ game, matchup, trends = [], injuries = {}, weather = null, bets = [], props = [], propNotes = () => null, streaks = [] }) {
  const out = [];
  const H = game.home;
  const A = game.away;
  const sport = game.sport || 'NFL';
  const picks = Stats.picks(bets).filter((p) => (p.sport || '') === sport);
  const paper = matchup && matchup.onPaper;

  // ---------- spread (one side) ----------
  if (game.homeSpread != null) {
    const sides = [H, A].map((team) => {
      const opp = team === H ? A : H;
      const line = team === H ? game.homeSpread : -game.homeSpread;
      const reasons = [];
      if (paper) {
        const margin = team === A ? paper.margin : -paper.margin; // matchup is from the away team's side
        const cover = margin + line;
        if (Math.abs(cover) >= 1) reasons.push({ dir: cover > 0 ? 1 : -1, weight: clamp(Math.abs(cover) / 3, 0.3, 2), source: 'Rankings', text: `On paper ${team} ${margin >= 0 ? 'wins' : 'loses'} by ${Math.abs(margin).toFixed(1)}, ${cover > 0 ? 'covering' : 'missing'} ${fmtLine(line)} by ${Math.abs(cover).toFixed(1)}` });
        const e = matchup.edges;
        const diff = (e[team] || 0) - (e[opp] || 0);
        if (Math.abs(diff) >= 2) reasons.push({ dir: diff > 0 ? 1 : -1, weight: clamp(Math.abs(diff) * 0.25, 0.3, 1), source: 'Rankings', text: `${team} has the edge in ${e[team]} offense-vs-defense matchups, ${opp} in ${e[opp]}` });
      }
      for (const t of trends) {
        if (!t.suggest || t.suggest.betType !== 'Spread') continue;
        const backs = t.suggest.side === 'team' ? t.team : t.opp;
        reasons.push({ dir: backs === team ? 1 : -1, weight: clamp(t.score / 5, 0.2, 1.2), source: 'Trends', text: `${t.team} ${t.text}` });
      }
      const myQb = qbsOut(injuries, team);
      const theirQb = qbsOut(injuries, opp);
      if (myQb.length) reasons.push({ dir: -1, weight: 1.5, source: 'Injuries', text: `${team} QB ${myQb.map((p) => `${p.name} (${p.status})`).join(', ')}; the line may already account for it` });
      if (theirQb.length) reasons.push({ dir: 1, weight: 1, source: 'Injuries', text: `${opp} QB ${theirQb.map((p) => `${p.name} (${p.status})`).join(', ')}; the line may already account for it` });
      const mine = keyOut(injuries, team);
      if (mine.length >= 2) reasons.push({ dir: -1, weight: 0.5, source: 'Injuries', text: `${team} is missing ${mine.map((p) => `${p.position} ${p.name}`).join(', ')}` });
      const onTeam = recordReason(recordOf(picks, (p) => p.team === team && ['Spread', 'Moneyline'].includes(p.betType)), `betting on ${team}`);
      if (onTeam) reasons.push(onTeam);
      const against = recordOf(picks, (p) => p.opponent === team && ['Spread', 'Moneyline'].includes(p.betType));
      if (against.n >= 5 && against.rate <= 0.4) reasons.push({ dir: 1, weight: 0.4, source: 'Your record', text: `You're ${against.w}-${against.l} betting against ${team}` });
      const spreads = recordReason(recordOf(picks, (p) => p.betType === 'Spread'), `on ${sport} spreads`, 10);
      if (spreads && spreads.dir < 0) reasons.push({ ...spreads, weight: 0.3 });
      const best = game.best && (team === H ? game.best.homeSpread : game.best.awaySpread);
      return finish({
        kind: 'game', betType: 'Spread', title: `${team} ${fmtLine(line)}`, odds: best ? best.price : null, book: best ? best.book : null,
        pick: { betType: 'Spread', team, opponent: opp, line, odds: best ? best.price : -110 }, reasons,
      });
    });
    const better = sides.sort((x, y) => y.score - x.score)[0];
    if (better.score >= 1) out.push(better);

    // ---------- underdog moneyline when the dog wins on paper ----------
    if (paper) {
      const dog = game.homeSpread > 0 ? H : game.homeSpread < 0 ? A : null;
      if (dog) {
        const margin = dog === A ? paper.margin : -paper.margin;
        const price = dog === H ? game.homeML : game.awayML;
        if (margin > 0.5) {
          const reasons = [{ dir: 1, weight: clamp(margin / 2.5, 0.5, 2), source: 'Rankings', text: `${dog} is the underdog but wins by ${margin.toFixed(1)} on paper` }];
          if (price != null) reasons.push({ dir: 1, weight: 0.4, source: 'Odds', text: `Pays ${fmtOdds(price)}` });
          if (qbsOut(injuries, dog).length) reasons.push({ dir: -1, weight: 1.5, source: 'Injuries', text: `${dog} QB ${qbsOut(injuries, dog).map((p) => `${p.name} (${p.status})`).join(', ')}` });
          const ml = recordReason(recordOf(picks, (p) => p.betType === 'Moneyline' && Number(p.odds) > 0), 'on underdog moneylines');
          if (ml) reasons.push(ml);
          const s = finish({ kind: 'game', betType: 'Moneyline', title: `${dog} moneyline`, odds: price, pick: { betType: 'Moneyline', team: dog, opponent: dog === H ? A : H, odds: price ?? '' }, reasons });
          if (s.score >= 1) out.push(s);
        }
      }
    }
  }

  // ---------- total ----------
  if (game.total != null) {
    const reasons = []; // dir +1 = Over
    if (paper) {
      const diff = paper.total - game.total;
      if (Math.abs(diff) >= 1) reasons.push({ dir: diff > 0 ? 1 : -1, weight: clamp(Math.abs(diff) / 3, 0.3, 2), source: 'Rankings', text: `On paper about ${paper.total.toFixed(1)} points vs a total of ${game.total}` });
    }
    for (const t of trends) {
      if (!t.suggest || t.suggest.betType !== 'Total') continue;
      reasons.push({ dir: t.suggest.side === 'Over' ? 1 : -1, weight: clamp(t.score / 5, 0.2, 1.2), source: 'Trends', text: `${t.team} ${t.text}` });
    }
    if (weather && weather.roof !== 'dome' && !game.indoor) {
      if ((weather.wind != null && weather.wind >= 15) || (weather.gust != null && weather.gust >= 25)) reasons.push({ dir: -1, weight: weather.wind >= 20 ? 1.2 : 0.8, source: 'Weather', text: `Wind ${weather.wind} mph${weather.gust ? ` (gusts ${weather.gust})` : ''} hurts passing and kicking` });
      if (weather.precipChance != null && weather.precipChance >= 60) reasons.push({ dir: -1, weight: 0.5, source: 'Weather', text: `${weather.precipChance}% chance of rain or snow` });
    }
    const qbs = [...qbsOut(injuries, H), ...qbsOut(injuries, A)];
    if (qbs.length) reasons.push({ dir: -1, weight: 0.8, source: 'Injuries', text: `QB out or doubtful: ${qbs.map((p) => p.name).join(', ')}` });
    const net = reasons.reduce((a, r) => a + r.dir * r.weight, 0);
    const side = net >= 0 ? 'Over' : 'Under';
    const sideReasons = reasons.map((r) => (side === 'Over' ? r : { ...r, dir: -r.dir }));
    const yours = recordReason(recordOf(picks, (p) => p.betType === 'Total' && p.side === side), `on ${sport} ${side.toLowerCase()}s`);
    if (yours) sideReasons.push(yours);
    const best = game.best && (side === 'Over' ? game.best.over : game.best.under);
    const s = finish({
      kind: 'game', betType: 'Total', title: `${side} ${game.total}`, odds: best ? best.price : null, book: best ? best.book : null,
      pick: { betType: 'Total', team: A, opponent: H, side, line: game.total, odds: best ? best.price : -110 }, reasons: sideReasons,
    });
    if (s.score >= 1) out.push(s);
  }

  // ---------- player props ----------
  const seenProp = new Set();
  const streakFor = (player, category) => streaks.find((x) => x.player === player && x.category === category);
  for (const p of props) {
    if (!p.team || !p.opp) continue;
    const key = `${p.player}|${p.category}`;
    if (seenProp.has(key)) continue;
    seenProp.add(key);
    const best = [];
    for (const side of p.yesNo ? ['Yes', 'No'] : ['Over', 'Under']) {
      const notes = propNotes({ ...p, side });
      const reasons = [];
      if (notes) {
        const strong = notes.factors.filter((f) => f.impact !== 'minor' && f.lean !== 0).slice(0, 2);
        reasons.push({
          dir: notes.score > 0 ? 1 : -1, weight: clamp(Math.abs(notes.score) * 3, 0.2, 2), source: 'Matchup',
          text: strong.length ? `${p.opp} ranks ${strong.map((f) => `${ord(f.rank)} in ${f.label.toLowerCase()}`).join(', ')}` : `${p.opp} defense: ${notes.verdict.replace('-', ' ')} matchup`,
        });
      }
      const st = streakFor(p.player, p.category);
      if (st && (side === 'Over' || side === 'Yes')) reasons.push({ dir: 1, weight: 0.6, source: 'Streak', text: `${p.player} ${st.text}` });
      const mine = recordReason(recordOf(picks, (x) => x.propCategory === p.category && x.side === side), `on ${p.category} ${side.toLowerCase()}s`);
      if (mine) reasons.push(mine);
      const price = side === 'Over' || side === 'Yes' ? p.over : p.under;
      best.push(
        finish({
          kind: 'prop', betType: 'Player Prop', title: `${p.player} ${side}${p.line != null ? ` ${p.line}` : ''} ${p.category}`, odds: price ? price.price : null, book: price ? price.book : null,
          pick: { betType: 'Player Prop', player: p.player, team: p.team, opponent: p.opp, propCategory: p.category, side, line: p.line ?? '', odds: price ? price.price : -110 }, reasons,
        })
      );
    }
    const top = best.sort((x, y) => y.score - x.score)[0];
    if (top && top.score >= 1) out.push(top);
  }

  // ---------- player angles without a prop line (streak + matchup) ----------
  if (!props.length) {
    for (const st of streaks) {
      const opp = st.team === H ? A : H;
      const notes = propNotes({ player: st.player, category: st.category, team: st.team, opp, side: 'Over', qb: st.qb });
      if (!notes || notes.score < 0.12) continue;
      const reasons = [
        { dir: 1, weight: 0.8, source: 'Streak', text: `${st.player} ${st.text}` },
        { dir: 1, weight: clamp(notes.score * 3, 0.3, 2), source: 'Matchup', text: `${opp} defense: ${notes.verdict === 'favorable' ? 'good spot' : 'leans Over'} for ${st.category.toLowerCase()}` },
      ];
      const s = finish({
        kind: 'prop', betType: 'Player Prop', title: `${st.player} ${st.threshold != null ? `${st.threshold}+ ` : ''}${st.category}`, odds: null, angle: true,
        pick: { betType: 'Player Prop', player: st.player, team: st.team, opponent: opp, propCategory: st.category, side: 'Over', line: st.threshold != null ? st.threshold - 0.5 : '' },
        reasons,
      });
      if (s.score >= 1) out.push(s);
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 12);
}

module.exports = { advise, recordOf };
