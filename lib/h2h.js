'use strict';

// Head-to-head history from ESPN's public site API:
// - team schedules (…/teams/{abbr}/schedule?season=YYYY&seasontype=2|3) to find past meetings
// - game summaries (…/summary?event=ID) for leaders and team stats
// Everything here is pure parsing/analysis so it can be unit-tested with fixtures.

function str(v) {
  return v == null ? '' : String(v);
}
function num(v) {
  if (v && typeof v === 'object') v = v.value != null ? v.value : v.displayValue;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

// Seasons worth searching, newest first. NFL seasons are named by start year;
// NBA seasons by end year (2025-26 => 2026).
function seasonsToSearch(league, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  if (league === 'nba') {
    const cur = m >= 8 ? y + 1 : y;
    return [cur, cur - 1, cur - 2];
  }
  const cur = m >= 3 ? y : y - 1;
  return [cur, cur - 1, cur - 2, cur - 3];
}

// Completed games against `opp` from one team-schedule payload.
function meetingsFromSchedule(json, opp) {
  const events = Array.isArray(json && json.events) ? json.events : [];
  const out = [];
  for (const e of events) {
    const comp = (Array.isArray(e.competitions) && e.competitions[0]) || {};
    const type = (comp.status && comp.status.type) || (e.status && e.status.type) || {};
    if (!(type.completed || type.state === 'post')) continue;
    const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
    if (!cs.some((c) => c && c.team && str(c.team.abbreviation).toUpperCase() === opp)) continue;
    out.push({ id: str(e.id), date: str(e.date || comp.date), postseason: !!(e.seasonType && Number(e.seasonType.type) === 3) });
  }
  return out;
}

const NFL_LEADER_RULES = {
  passingYards: (v, d) => v >= 300 || tds(d) >= 3,
  rushingYards: (v, d) => v >= 100 || tds(d) >= 2,
  receivingYards: (v, d) => v >= 100 || tds(d) >= 2,
};
const NBA_LEADER_RULES = {
  points: (v) => v >= 30,
  rebounds: (v) => v >= 15,
  assists: (v) => v >= 10,
};
function tds(display) {
  const m = /(\d+)\s*TD/i.exec(str(display));
  return m ? Number(m[1]) : 0;
}

function teamStat(boxTeam, names) {
  const stats = (boxTeam && Array.isArray(boxTeam.statistics) && boxTeam.statistics) || [];
  for (const n of names) {
    const s = stats.find((x) => x && (x.name === n || x.label === n || x.abbreviation === n));
    if (s) return num(s.displayValue != null ? s.displayValue : s.value);
  }
  return null;
}

// Parse one game summary into a compact record with notable performances.
function parseGameSummary(json, league) {
  const comp = (json && json.header && Array.isArray(json.header.competitions) && json.header.competitions[0]) || {};
  const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
  const teams = cs.map((c) => ({
    abbr: str(c.team && c.team.abbreviation).toUpperCase(),
    name: str(c.team && (c.team.displayName || c.team.name)),
    homeAway: str(c.homeAway),
    score: num(c.score),
    winner: !!c.winner,
  }));
  if (teams.length !== 2 || teams.some((t) => t.score == null)) return null;
  const [a, b] = teams;
  const winner = a.score === b.score ? null : a.score > b.score ? a : b;
  const loser = winner === a ? b : winner === b ? a : null;

  // stat leaders per team
  const rules = league === 'nba' ? NBA_LEADER_RULES : NFL_LEADER_RULES;
  const leaders = [];
  for (const group of Array.isArray(json.leaders) ? json.leaders : []) {
    const abbr = str(group.team && group.team.abbreviation).toUpperCase();
    for (const cat of Array.isArray(group.leaders) ? group.leaders : []) {
      const top = Array.isArray(cat.leaders) && cat.leaders[0];
      if (!top || !top.athlete) continue;
      const value = num(top.value) != null ? num(top.value) : num(top.displayValue);
      leaders.push({
        team: abbr,
        category: str(cat.name),
        label: str(cat.displayName || cat.name),
        player: str(top.athlete.displayName || top.athlete.fullName),
        position: str(top.athlete.position && top.athlete.position.abbreviation),
        display: str(top.displayValue),
        big: !!(rules[cat.name] && value != null && rules[cat.name](value, top.displayValue)),
      });
    }
  }

  // team stats from the box score
  const box = (json.boxscore && Array.isArray(json.boxscore.teams) && json.boxscore.teams) || [];
  const boxFor = (abbr) => box.find((t) => t && t.team && str(t.team.abbreviation).toUpperCase() === abbr);
  const stats = {};
  for (const t of teams) {
    const bt = boxFor(t.abbr);
    stats[t.abbr] =
      league === 'nba'
        ? { fgPct: teamStat(bt, ['fieldGoalPct', 'FG%']), threePct: teamStat(bt, ['threePointFieldGoalPct', '3P%']), rebounds: teamStat(bt, ['totalRebounds', 'REB']), turnovers: teamStat(bt, ['turnovers', 'totalTurnovers', 'TO']) }
        : { yards: teamStat(bt, ['totalYards', 'Total Yards']), turnovers: teamStat(bt, ['turnovers', 'Turnovers']) };
  }

  // notable storylines
  const notes = [];
  const margin = winner ? winner.score - loser.score : 0;
  const total = a.score + b.score;
  if (winner && margin >= (league === 'nba' ? 15 : 17)) notes.push({ type: 'blowout', team: winner.abbr, text: `${winner.abbr} won by ${margin}` });
  if (winner && margin <= (league === 'nba' ? 3 : 3)) notes.push({ type: 'close', text: `Decided by ${margin}` });
  for (const t of teams) {
    const opp = t === a ? b : a;
    const st = stats[t.abbr] || {};
    const oppSt = stats[opp.abbr] || {};
    if (league === 'nba') {
      if (t.score >= 130 || (st.fgPct != null && st.fgPct >= 55)) notes.push({ type: 'offense', team: t.abbr, text: `${t.abbr} offense: ${t.score} pts${st.fgPct != null ? `, ${st.fgPct}% FG` : ''}` });
      if (opp.score <= 95) notes.push({ type: 'defense', team: t.abbr, text: `${t.abbr} defense held ${opp.abbr} to ${opp.score}` });
    } else {
      if (t.score >= 35 || (st.yards != null && st.yards >= 450)) notes.push({ type: 'offense', team: t.abbr, text: `${t.abbr} offense: ${t.score} pts${st.yards != null ? `, ${st.yards} yds` : ''}` });
      if (opp.score <= 10 || (oppSt.turnovers != null && oppSt.turnovers >= 3))
        notes.push({ type: 'defense', team: t.abbr, text: `${t.abbr} defense: held ${opp.abbr} to ${opp.score}${oppSt.turnovers != null && oppSt.turnovers >= 3 ? `, forced ${oppSt.turnovers} TO` : ''}` });
    }
  }

  return {
    id: str(json.header && json.header.id),
    date: str(comp.date),
    teams,
    winner: winner ? winner.abbr : null,
    margin,
    total,
    leaders,
    stats,
    notes,
  };
}

// Head-to-head summary across games, from team `a`'s point of view.
function summarizeH2H(games, a, b) {
  const s = { games: games.length, wins: { [a]: 0, [b]: 0 }, ties: 0, avgTotal: null, avgMargin: null };
  if (!games.length) return s;
  let total = 0, margin = 0;
  for (const g of games) {
    if (g.winner === a || g.winner === b) s.wins[g.winner]++;
    else s.ties++;
    total += g.total;
    const ta = g.teams.find((t) => t.abbr === a);
    const tb = g.teams.find((t) => t.abbr === b);
    if (ta && tb) margin += ta.score - tb.score;
  }
  s.avgTotal = Math.round((total / games.length) * 10) / 10;
  s.avgMargin = Math.round((margin / games.length) * 10) / 10;
  return s;
}

module.exports = { seasonsToSearch, meetingsFromSchedule, parseGameSummary, summarizeH2H };
