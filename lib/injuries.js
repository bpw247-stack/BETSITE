'use strict';

// Normalizes ESPN's injuries payload
// (site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries)
// into: [{ team, abbr, players: [{ name, position, status, injury, returnDate, date, comment, detail }] }]
// Parsing is defensive: any missing field becomes an empty string.

function str(v) {
  return v == null ? '' : String(v);
}

function describeInjury(details) {
  if (!details || typeof details !== 'object') return '';
  const bits = [details.side && details.side !== 'Not Specified' ? details.side : '', details.type, details.detail]
    .map(str)
    .filter(Boolean);
  return bits.join(' ');
}

function parseEspnInjuries(json) {
  const groups = Array.isArray(json && json.injuries) ? json.injuries : [];
  return groups
    .map((g) => {
      const list = Array.isArray(g.injuries) ? g.injuries : [];
      const firstTeam = list.find((i) => i && i.athlete && i.athlete.team);
      const abbr = str(
        (g.team && g.team.abbreviation) || (firstTeam && firstTeam.athlete.team.abbreviation) || g.abbreviation
      ).toUpperCase();
      return {
        team: str(g.displayName || (g.team && g.team.displayName) || abbr),
        abbr,
        players: list
          .filter(Boolean)
          .map((i) => {
            const a = i.athlete || {};
            return {
              name: str(a.displayName || a.fullName),
              position: str(a.position && (a.position.abbreviation || a.position.name)),
              status: str(i.status || (i.type && i.type.description)),
              injury: describeInjury(i.details),
              returnDate: str(i.details && i.details.returnDate),
              date: str(i.date),
              comment: str(i.shortComment),
              detail: str(i.longComment),
            };
          })
          .filter((p) => p.name),
      };
    })
    .filter((t) => t.team)
    .sort((a, b) => a.team.localeCompare(b.team));
}

module.exports = { parseEspnInjuries };
