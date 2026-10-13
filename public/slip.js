// Bet slip parser: turns pasted sportsbook confirmation text into bet fields.
// Heuristic by design (every book formats slips differently); the user reviews the result.
// Works in the browser (window.BetSlip, needs window.LEAGUES) and in Node (module.exports).
(function (root) {
  'use strict';

  const BOOKS = [
    ['DraftKings', /draft\s*kings|\bdk\b/i], ['FanDuel', /fan\s*duel/i], ['BetMGM', /bet\s*mgm|\bmgm\b/i], ['Caesars', /caesars/i],
    ['ESPN Bet', /espn\s*bet/i], ['Fanatics', /fanatics/i], ['bet365', /bet\s*365/i], ['BetRivers', /bet\s*rivers/i],
    ['Hard Rock Bet', /hard\s*rock/i], ['theScore Bet', /the\s*score\s*bet/i],
  ];

  // phrase (lowercase) -> prop category used by the site
  const PROP_PHRASES = [
    ['rush + rec yards', 'Rush + Rec Yards'], ['rushing + receiving yards', 'Rush + Rec Yards'], ['rush+rec yds', 'Rush + Rec Yards'],
    ['passing yards', 'Passing Yards'], ['pass yards', 'Passing Yards'], ['passing yds', 'Passing Yards'], ['pass yds', 'Passing Yards'],
    ['passing touchdowns', 'Passing TDs'], ['passing tds', 'Passing TDs'], ['pass tds', 'Passing TDs'],
    ['pass completions', 'Pass Completions'], ['completions', 'Pass Completions'], ['pass attempts', 'Pass Attempts'],
    ['interceptions', 'Interceptions Thrown'], ['rushing yards', 'Rushing Yards'], ['rush yards', 'Rushing Yards'], ['rushing yds', 'Rushing Yards'], ['rush yds', 'Rushing Yards'],
    ['rushing attempts', 'Rushing Attempts'], ['rush attempts', 'Rushing Attempts'], ['receiving yards', 'Receiving Yards'], ['receiving yds', 'Receiving Yards'], ['rec yds', 'Receiving Yards'],
    ['receptions', 'Receptions'], ['longest reception', 'Longest Reception'], ['anytime touchdown', 'Anytime TD'], ['anytime td', 'Anytime TD'],
    ['to score a touchdown', 'Anytime TD'], ['first touchdown', 'First TD'], ['first td', 'First TD'], ['2+ touchdowns', '2+ TDs'], ['2+ tds', '2+ TDs'],
    ['tackles + assists', 'Tackles + Assists'], ['sacks', 'Sacks'], ['kicking points', 'Kicking Points'], ['field goals made', 'Field Goals Made'],
    ['points + rebounds + assists', 'Pts + Reb + Ast'], ['pts + reb + ast', 'Pts + Reb + Ast'], ['pts+reb+ast', 'Pts + Reb + Ast'], ['pra', 'Pts + Reb + Ast'],
    ['points + rebounds', 'Pts + Reb'], ['pts + reb', 'Pts + Reb'], ['points + assists', 'Pts + Ast'], ['pts + ast', 'Pts + Ast'],
    ['rebounds + assists', 'Reb + Ast'], ['reb + ast', 'Reb + Ast'], ['steals + blocks', 'Steals + Blocks'],
    ['three pointers made', '3-Pointers Made'], ['3-pointers made', '3-Pointers Made'], ['threes made', '3-Pointers Made'], ['3pt made', '3-Pointers Made'], ['made threes', '3-Pointers Made'],
    ['double-double', 'Double-Double'], ['double double', 'Double-Double'], ['triple-double', 'Triple-Double'], ['triple double', 'Triple-Double'],
    ['first basket', 'First Basket'], ['points', 'Points'], ['rebounds', 'Rebounds'], ['assists', 'Assists'], ['steals', 'Steals'], ['blocks', 'Blocks'], ['turnovers', 'Turnovers'],
  ].sort((a, b) => b[0].length - a[0].length);
  const NBA_PROPS = new Set(['Points', 'Rebounds', 'Assists', 'Pts + Reb + Ast', 'Pts + Reb', 'Pts + Ast', 'Reb + Ast', '3-Pointers Made', 'Steals', 'Blocks', 'Steals + Blocks', 'Turnovers', 'Double-Double', 'Triple-Double', 'First Basket']);
  const YES_PROPS = new Set(['Anytime TD', 'First TD', '2+ TDs', 'Double-Double', 'Triple-Double', 'First Basket']);

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function teamIndex(leagues) {
    const idx = [];
    for (const sport of Object.keys(leagues || {})) {
      for (const [abbr, name] of leagues[sport]) {
        const nick = name.split(' ').pop();
        idx.push({ sport, abbr, re: new RegExp(`\\b(${escRe(name)}|${escRe(nick)})\\b`, 'i'), abbrRe: new RegExp(`(^|[\\s(@])${escRe(abbr)}(?=[\\s),@]|$)`) });
      }
    }
    return idx;
  }

  function findTeams(line, idx) {
    const hits = [];
    for (const t of idx) {
      const m = t.re.exec(line) || t.abbrRe.exec(line);
      if (m) hits.push({ sport: t.sport, abbr: t.abbr, at: m.index });
    }
    return hits.sort((a, b) => a.at - b.at);
  }

  const money = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));
  const oddsTokens = (line) => [...line.matchAll(/(?:^|[\s(@])([+-]\d{3,5})(?=[\s)]|$)/g)].map((m) => Number(m[1])).filter((o) => Math.abs(o) >= 100);
  const propCategory = (line) => {
    const l = line.toLowerCase();
    const hit = PROP_PHRASES.find(([p]) => new RegExp(`(^|[^a-z])${escRe(p)}([^a-z]|$)`).test(l));
    return hit ? hit[1] : null;
  };
  const propIndex = (line) => {
    const l = line.toLowerCase();
    let best = null;
    for (const [p] of PROP_PHRASES) {
      const m = new RegExp(`(^|[^a-z])${escRe(p)}([^a-z]|$)`).exec(l);
      if (m && (best == null || m.index < best)) best = m.index + (m[1] ? 1 : 0);
    }
    return best;
  };
  const toAmerican = (profit, stake) => {
    if (!(profit > 0 && stake > 0)) return null;
    const d = profit / stake;
    return Math.round(d >= 1 ? d * 100 : -100 / d);
  };

  // Read one selection line (with optional next line as context).
  function parseSelection(line, idx) {
    const teams = findTeams(line, idx);
    const cat = propCategory(line);
    const ou = /\b(over|under|o|u)\s*(\d+(?:\.\d+)?)\b/i.exec(line);
    const plus = /\b(\d+(?:\.\d+)?)\+\s/.exec(line + ' '); // "250+ Passing Yards" style alt lines
    const odds = oddsTokens(line);
    // player name: the capitalized words before the bet itself (over/under, prop name, "Anytime", "25+")
    const cut = Math.min(
      ...[ou && ou.index, plus && plus.index, (/\b(anytime|alt|alternate|to score|first|total|moneyline|ml|-|:)\b|\s[-:]\s/i.exec(line) || {}).index, propIndex(line)].filter((x) => x != null && x > 0),
      line.length
    );
    const lead = line.slice(0, cut).replace(/[\s:-]+$/, '').trim();
    const nameM = /^[A-Z][A-Za-z.'-]+(?:\s+(?:[A-Z][A-Za-z.'-]+|Jr\.?|Sr\.?|II|III|IV)){1,3}$/.test(lead) ? [lead, lead] : null;
    const nameIsTeam = nameM && findTeams(nameM[1], idx).length > 0;
    const sideWord = ou ? (/^o/i.test(ou[1]) ? 'Over' : 'Under') : null;

    if (cat && nameM && !nameIsTeam) {
      const sel = { betType: 'Player Prop', player: nameM[1].replace(/\s+-$/, ''), propCategory: cat, sport: NBA_PROPS.has(cat) ? 'NBA' : 'NFL' };
      if (ou) {
        sel.side = sideWord;
        sel.line = Number(ou[2]);
      } else if (plus) {
        sel.side = 'Over';
        sel.line = Number(plus[1]) - 0.5;
      } else if (YES_PROPS.has(cat)) {
        sel.side = /\bno\b/i.test(line) ? 'No' : 'Yes';
      }
      if (odds.length) sel.odds = odds[odds.length - 1];
      return sel;
    }
    if (cat && teams.length && /team total/i.test(line + cat)) return null;
    if (/team total/i.test(line) && teams.length && ou) {
      return { betType: 'Game Prop', propCategory: 'Team Total', team: teams[0].abbr, sport: teams[0].sport, side: sideWord, line: Number(ou[2]), odds: odds[odds.length - 1] };
    }
    if (ou && (/\btotal\b|\bpoints\b|\bruns\b/i.test(line) || !nameM || nameIsTeam || teams.length)) {
      const sel = { betType: 'Total', side: sideWord, line: Number(ou[2]) };
      if (teams[0]) Object.assign(sel, { team: teams[0].abbr, sport: teams[0].sport });
      if (teams[1]) sel.opponent = teams[1].abbr;
      if (odds.length) sel.odds = odds[odds.length - 1];
      return sel;
    }
    if (teams.length) {
      const t = teams[0];
      const after = line.slice(t.at);
      const spread = /\s([+-]\d{1,2}(?:\.5)?|pk|pick'?em|even)(?=[\s)]|$)/i.exec(after);
      const sel = { team: t.abbr, sport: t.sport };
      if (spread && !/moneyline|\bml\b|to win/i.test(line)) {
        sel.betType = 'Spread';
        sel.line = /^[+-]/.test(spread[1]) ? Number(spread[1]) : 0;
      } else if (/moneyline|\bml\b|to win|winner/i.test(line) || odds.length) {
        sel.betType = 'Moneyline';
      } else {
        return null;
      }
      if (teams[1]) sel.opponent = teams[1].abbr;
      if (odds.length) sel.odds = odds[odds.length - 1];
      return sel;
    }
    return null;
  }

  function parseSlip(text, leagues) {
    const idx = teamIndex(leagues || (root && root.LEAGUES));
    const clean = String(text || '').replace(/[−–—]/g, '-').replace(/ /g, ' ');
    const lines = joinLines(clean.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean), idx);
    const all = lines.join('\n');
    const out = { warnings: [], legs: [] };

    const book = BOOKS.find(([, re]) => re.test(all));
    if (book) out.book = book[0];

    const stakeM = /(?:total\s+)?(?:wager(?:ed)?|stake|risk|bet amount|amount)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i.exec(all) || /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:wager|stake|bet)/i.exec(all);
    if (stakeM) out.stake = money(stakeM[1]);
    const winM = /(?:to win|potential win(?:nings)?|win amount)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i.exec(all);
    const payM = /(?:potential payout|total payout|payout|to pay|returns?)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i.exec(all);
    const toWin = winM ? money(winM[1]) : payM && out.stake ? money(payM[1]) - out.stake : null;
    if (toWin != null) out.toWin = Math.round(toWin * 100) / 100;

    const dateM = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(all) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(all);
    if (dateM) {
      const mon = isNaN(dateM[1]) ? 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(dateM[1].slice(0, 3).toLowerCase()) / 3 + 1 : Number(dateM[1]);
      const day = Number(dateM[2]);
      const yr = Number(dateM[3]) < 100 ? 2000 + Number(dateM[3]) : Number(dateM[3]);
      if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) out.date = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // selections
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/wager|stake|payout|to win:|potential|bet id|ticket|placed|cash ?out|odds boost|receipt/i.test(line) && !propCategory(line)) continue;
      const sel = parseSelection(line, idx);
      if (!sel) continue;
      // a prop whose "Under 48.5 -115" sits on the next line
      const bare = sel.betType === 'Player Prop' && sel.line == null && lines[i + 1] && BARE_OU.exec(lines[i + 1]);
      if (bare) {
        sel.side = /^o/i.test(bare[1]) ? 'Over' : 'Under';
        sel.line = Number(bare[2]);
        if (bare[3]) sel.odds = Number(bare[3]);
        i++;
      }
      // context from the next few lines (until the next selection): matchup ("Bills @ Chiefs") and odds
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const next = lines[j];
        if (parseSelection(next, idx)) break;
        applyContext(sel, next, idx);
      }
      out.legs.push(sel);
    }

    // de-duplicate (some books repeat the selection)
    const seen = new Set();
    out.legs = out.legs.filter((l) => {
      const k = JSON.stringify([l.betType, l.team, l.player, l.propCategory, l.side, l.line]);
      return !seen.has(k) && seen.add(k);
    });
    return finish(out, lines, all);
  }

  const BARE_OU = /^(over|under|o|u)\s*(\d+(?:\.\d+)?)(?:\s+([+-]\d{3,5}))?$/i;
  const NAME_RE = /^[A-Z][A-Za-z.'-]+(?:\s+(?:[A-Z][A-Za-z.'-]+|Jr\.?|Sr\.?|II|III|IV)){1,3}$/;

  // Undo line breaks that split one selection, which is common in screenshots:
  // "Nikola Jokic - Points + Rebounds +" / "Assists", and
  // "Josh Allen  +105" / "Over 249.5 Passing Yards".
  function joinLines(lines, idx) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      while (/(?:\s[+&,-]|\band)$/i.test(line) && i + 1 < lines.length) line = `${line} ${lines[++i]}`;
      const next = lines[i + 1];
      const odds = oddsTokens(line);
      const name = line.replace(/(?:^|\s)[+-]\d{3,5}(?=\s|$)/g, '').trim();
      if (next && NAME_RE.test(name) && !findTeams(name, idx).length && !propCategory(name) && (propCategory(next) || BARE_OU.test(next) || /^(over|under)\s+\d/i.test(next)) && !BOOKS.some(([, re]) => re.test(name)) && !NAME_RE.test(next.split(/\s[-:]\s|\s+(?:over|under|o|u)\s*\d/i)[0])) {
        line = `${name} ${next}${odds.length && !oddsTokens(next).length ? ` ${odds[odds.length - 1] > 0 ? '+' : ''}${odds[odds.length - 1]}` : ''}`;
        i++;
      }
      out.push(line);
    }
    return out;
  }

  function applyContext(sel, next, idx) {
    const nextTeams = findTeams(next, idx);
    const isHeader = /parlay|sgp|\d+\s*[- ]?(leg|pick)/i.test(next);
    if (sel.odds == null && !isHeader && oddsTokens(next).length) sel.odds = oddsTokens(next)[0];
    if (/(@|\bat\b|\bvs\.?\b)/i.test(next) && nextTeams.length >= 2) {
        if (sel.betType === 'Player Prop') {
          sel.game = `${nextTeams[0].abbr} @ ${nextTeams[1].abbr}`; // which side the player is on isn't on the slip
        } else if (!sel.team) {
          sel.team = nextTeams[0].abbr;
          sel.opponent = nextTeams[1].abbr;
        } else if (!sel.opponent) {
          const other = nextTeams.find((t) => t.abbr !== sel.team);
          if (other) sel.opponent = other.abbr;
          if (sel.betType === 'Player Prop') {
            // player's team is unknown; leave team blank but keep the game
            sel.game = `${nextTeams[0].abbr} @ ${nextTeams[1].abbr}`;
            delete sel.opponent;
          }
        }
        if (!sel.sport) sel.sport = nextTeams[0].sport;
    }
  }

  function finish(out, lines, all) {
    const parlayM = /(\d+)\s*[- ]?\s*(?:leg|pick|team)s?\b.*?(?:parlay|sgp)|same\s*game\s*parlay|\bsgp\b|\bparlay\b/i.exec(all);
    out.betType = parlayM || out.legs.length > 1 ? 'Parlay' : out.legs[0] ? out.legs[0].betType : null;

    // overall odds: a parlay's odds are usually on the header line; else the only odds on the slip
    const allOdds = lines.flatMap(oddsTokens);
    if (out.betType === 'Parlay') {
      const header = lines.find((l) => /parlay|sgp|\d+\s*[- ]?(leg|pick)/i.test(l) && oddsTokens(l).length);
      const legOdds = new Set(out.legs.map((l) => l.odds).filter((o) => o != null));
      out.odds = header ? oddsTokens(header)[0] : allOdds.find((o) => !legOdds.has(o));
    } else if (out.legs[0] && out.legs[0].odds != null) {
      out.odds = out.legs[0].odds;
    } else if (allOdds.length) {
      out.odds = allOdds[0];
    }
    if (out.odds == null && out.toWin && out.stake) out.odds = toAmerican(out.toWin, out.stake);

    out.sport = (out.legs.find((l) => l.sport) || {}).sport || null;
    if (!out.legs.length) out.warnings.push("Couldn't find any selections. Fill in the details by hand.");
    if (out.stake == null) out.warnings.push('No stake found.');
    if (out.odds == null) out.warnings.push('No odds found.');
    if (out.legs.some((l) => l.betType === 'Player Prop' && !l.team)) out.warnings.push("Pick the player's team for player props, so research and auto-settle work.");
    return out;
  }

  // Convert a parsed slip into a bet object for the bet form.
  function slipToBet(p) {
    const base = { sport: p.sport || 'NFL', book: p.book || '', stake: p.stake ?? '', odds: p.odds ?? '', result: 'pending' };
    if (p.date) base.date = p.date;
    if (p.betType === 'Parlay') {
      return { ...base, betType: 'Parlay', legs: p.legs.map((l, i) => ({ id: `slip-${Date.now()}-${i}`, result: 'pending', sport: l.sport || base.sport, betType: l.betType, team: l.team || '', opponent: l.opponent || '', player: l.player || '', propCategory: l.propCategory || '', side: l.side || '', line: l.line ?? '', odds: l.odds ?? '' })) };
    }
    const l = p.legs[0] || {};
    return { ...base, sport: l.sport || base.sport, betType: l.betType || 'Moneyline', team: l.team || '', opponent: l.opponent || '', player: l.player || '', propCategory: l.propCategory || '', side: l.side || '', line: l.line ?? '' };
  }

  const api = { parseSlip, slipToBet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetSlip = api;
})(typeof window !== 'undefined' ? window : globalThis);
