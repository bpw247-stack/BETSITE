'use strict';

const { parseEspnLines } = require('./market');

// Normalizes ESPN's scoreboard payload
// (site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD-YYYYMMDD)
// into: [{ id, date, state, status, week, venue, tv, spread, overUnder, home: {...}, away: {...} }]
// Parsing is defensive: missing fields become '' / null.

function str(v) {
  return v == null ? '' : String(v);
}

function parseCompetitor(c) {
  const t = (c && c.team) || {};
  const rec = Array.isArray(c && c.records) ? c.records.find((r) => r && (r.type === 'total' || r.name === 'overall')) || c.records[0] : null;
  return {
    abbr: str(t.abbreviation).toUpperCase(),
    name: str(t.displayName || t.name),
    logo: str(t.logo),
    record: str(rec && rec.summary),
    score: c && c.score != null && c.score !== '' ? str(c.score) : '',
  };
}

function parseEspnScoreboard(json) {
  const events = Array.isArray(json && json.events) ? json.events : [];
  return events
    .map((e) => {
      const comp = (Array.isArray(e.competitions) && e.competitions[0]) || {};
      const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
      const home = competitors.find((c) => c && c.homeAway === 'home') || competitors[0];
      const away = competitors.find((c) => c && c.homeAway === 'away') || competitors[1];
      if (!home || !away) return null;
      const type = (e.status && e.status.type) || (comp.status && comp.status.type) || {};
      const odds = (Array.isArray(comp.odds) && comp.odds[0]) || {};
      const venue = comp.venue || {};
      const addr = venue.address || {};
      const tv = (Array.isArray(comp.broadcasts) ? comp.broadcasts : []).flatMap((b) => (b && Array.isArray(b.names) ? b.names : [])).join(', ');
      return {
        id: str(e.id),
        date: str(e.date || comp.date),
        state: str(type.state) || 'pre', // pre | in | post
        status: str(type.shortDetail || type.detail || type.description),
        week: e.week && e.week.number != null ? Number(e.week.number) : json.week && json.week.number != null ? Number(json.week.number) : null,
        neutralSite: !!comp.neutralSite,
        indoor: venue.indoor === true,
        venue: [str(venue.fullName), [str(addr.city), str(addr.state)].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
        tv,
        spread: str(odds.details),
        overUnder: odds.overUnder != null && odds.overUnder !== '' ? Number(odds.overUnder) : null,
        lines: parseEspnLines(comp, str(home.team && home.team.abbreviation).toUpperCase()),
        home: parseCompetitor(home),
        away: parseCompetitor(away),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// YYYYMMDD for a Date, in UTC-5 (close enough to US Eastern for picking schedule days)
function espnDay(d) {
  return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

module.exports = { parseEspnScoreboard, espnDay };
