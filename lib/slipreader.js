'use strict';

// Reads bet slip screenshots with Claude (when the user has added a Claude API key in
// Settings). Returns the same shape as public/slip.js parseSlip(), so the browser shows
// the same review step whether the free text reader or Claude read the slip.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODEL = 'claude-opus-5-5';
const MAX_IMAGES = 4;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const LEG_TYPES = ['Moneyline', 'Spread', 'Total', 'Player Prop', 'Game Prop', 'Future', 'Other'];
const SIDES = ['Over', 'Under', 'Yes', 'No'];

// teams.js is written for the browser (window.LEAGUES …); run it in a sandbox to share the lists.
function loadCatalog(file = path.join(__dirname, '..', 'public', 'teams.js')) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
  return { leagues: ctx.window.LEAGUES, props: ctx.window.PROP_CATEGORIES, betTypes: ctx.window.BET_TYPES };
}

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

function slipSchema({ leagues, betTypes }) {
  const abbrs = [...new Set(Object.values(leagues).flat().map(([a]) => a))].sort();
  const team = nullable({ type: 'string', enum: abbrs });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['is_bet_slip', 'book', 'bet_type', 'stake', 'to_win', 'odds', 'date', 'legs', 'notes'],
    properties: {
      is_bet_slip: { type: 'boolean', description: 'False when the images do not show a sports bet.' },
      book: nullable({ type: 'string' }),
      bet_type: nullable({ type: 'string', enum: betTypes }),
      stake: nullable({ type: 'number' }),
      to_win: nullable({ type: 'number', description: 'Profit if the bet wins, not including the stake.' }),
      odds: nullable({ type: 'integer', description: 'American odds for the whole bet (the parlay price for a parlay).' }),
      date: nullable({ type: 'string', format: 'date' }),
      notes: nullable({ type: 'string', description: 'Anything the user should double-check, in one short sentence.' }),
      legs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sport', 'bet_type', 'team', 'opponent', 'player', 'prop_category', 'side', 'line', 'odds'],
          properties: {
            sport: { type: 'string', enum: ['NFL', 'NBA', 'Other'] },
            bet_type: { type: 'string', enum: LEG_TYPES },
            team: team,
            opponent: team,
            player: nullable({ type: 'string' }),
            prop_category: nullable({ type: 'string' }),
            side: nullable({ type: 'string', enum: SIDES }),
            line: nullable({ type: 'number' }),
            odds: nullable({ type: 'integer' }),
          },
        },
      },
    },
  };
}

function instructions({ leagues, props }, today) {
  const teams = Object.entries(leagues)
    .map(([sport, list]) => `${sport}: ${list.map(([a, n]) => `${a}=${n}`).join(', ')}`)
    .join('\n');
  const cats = Object.entries(props)
    .filter(([sport]) => sport !== 'Other')
    .map(([sport, list]) => `${sport}: ${list.join(', ')}`)
    .join('\n');
  return `You read sportsbook bet slip screenshots for a personal bet tracker and fill in its bet form.
Today is ${today}. Use it to fill in a missing year; leave date null if the slip shows no date.

Rules:
- One leg per selection. A straight bet has one leg; a parlay or same-game parlay has one leg per pick and bet_type "Parlay".
- team and opponent use these abbreviations. For a total, team is the first team listed and opponent the other. For a player prop, team is the player's team only if you are sure of it, otherwise null, and opponent null.
${teams}
- prop_category: use one of these names when it fits, otherwise the slip's wording.
${cats}
- Spreads: line is the number for the team picked (e.g. -3.5). Moneylines: line null. Totals and over/under props: side Over or Under and line the number. "25+ Points" style alt lines: side Over, line 24.5. Yes/no props such as anytime touchdown: side Yes or No, line null.
- Odds are American (e.g. -110, +250). Convert decimal or fractional odds. Leave fields null when the slip doesn't show them; never guess a stake or odds.
- stake is the amount wagered. to_win is the profit; if only a total payout is shown, subtract the stake. Bonus bets or boosts: mention them in notes.
- If several images are given they are parts of the same slip.`;
}

// Map Claude's answer onto parseSlip()'s shape: { book, betType, odds, stake, toWin, date, sport, legs, warnings }.
function toParsed(raw, { leagues }) {
  const valid = (sport, abbr) => (abbr && (leagues[sport] || []).some(([a]) => a === abbr) ? abbr : null);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const odds = (v) => (Number.isInteger(v) && Math.abs(v) >= 100 ? v : null);
  const out = { warnings: [], legs: [], readBy: 'claude' };
  if (!raw || raw.is_bet_slip === false) {
    out.warnings.push("This doesn't look like a bet slip. Try a screenshot of the bet confirmation or the bet in My Bets.");
    return out;
  }
  for (const l of raw.legs || []) {
    const sport = ['NFL', 'NBA'].includes(l.sport) ? l.sport : 'Other';
    const leg = { betType: LEG_TYPES.includes(l.bet_type) ? l.bet_type : 'Other', sport };
    const team = valid(sport, l.team);
    const opponent = valid(sport, l.opponent);
    if (team) leg.team = team;
    if (opponent && opponent !== team) leg.opponent = opponent;
    if (l.player) leg.player = String(l.player).trim();
    if (l.prop_category) leg.propCategory = String(l.prop_category).trim();
    if (SIDES.includes(l.side)) leg.side = l.side;
    if (num(l.line) != null) leg.line = l.line;
    if (odds(l.odds) != null) leg.odds = l.odds;
    out.legs.push(leg);
  }
  if (raw.book) out.book = String(raw.book).trim();
  if (num(raw.stake) != null && raw.stake > 0) out.stake = raw.stake;
  if (num(raw.to_win) != null && raw.to_win >= 0) out.toWin = Math.round(raw.to_win * 100) / 100;
  if (odds(raw.odds) != null) out.odds = raw.odds;
  else if (out.legs.length === 1 && out.legs[0].odds != null) out.odds = out.legs[0].odds;
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) out.date = raw.date;
  out.betType = out.legs.length > 1 || raw.bet_type === 'Parlay' ? 'Parlay' : out.legs[0] ? out.legs[0].betType : null;
  out.sport = (out.legs.find((l) => l.sport !== 'Other') || out.legs[0] || {}).sport || null;

  if (!out.legs.length) out.warnings.push("Couldn't find any selections. Fill in the details by hand.");
  if (out.stake == null) out.warnings.push('No stake found.');
  if (out.odds == null) out.warnings.push('No odds found.');
  if (out.legs.some((l) => l.betType === 'Player Prop' && !l.team)) out.warnings.push("Pick the player's team for player props, so research and auto-settle work.");
  if (raw.notes) out.warnings.push(String(raw.notes));
  return out;
}

function checkImages(images) {
  if (!Array.isArray(images) || !images.length) throw Object.assign(new Error('Add a screenshot of the bet slip.'), { status: 400 });
  if (images.length > MAX_IMAGES) throw Object.assign(new Error(`Use at most ${MAX_IMAGES} screenshots per slip.`), { status: 400 });
  for (const img of images) {
    if (!img || !MEDIA_TYPES.includes(img.mediaType) || typeof img.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(img.data)) {
      throw Object.assign(new Error('Screenshots must be JPEG, PNG, WebP or GIF images.'), { status: 400 });
    }
  }
}

// Load the SDK only when it's used, so the rest of the site runs even before `npm install`.
function sdk() {
  try {
    return require('@anthropic-ai/sdk').default;
  } catch {
    return null;
  }
}

function createClient(apiKey) {
  const Anthropic = sdk();
  if (!Anthropic) throw Object.assign(new Error('BetsFriend is still installing what it needs to read slips with Claude. Try again in a minute; if it keeps happening, restart BetsFriend.'), { status: 503 });
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120000 });
}

async function readSlip({ apiKey, images, client, catalog = loadCatalog(), today = new Date().toISOString().slice(0, 10) }) {
  checkImages(images);
  const claude = client || createClient(apiKey);
  const Anthropic = sdk();

  let response;
  try {
    response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: slipSchema(catalog) } },
      system: instructions(catalog, today),
      messages: [
        {
          role: 'user',
          content: [
            ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
            { type: 'text', text: 'Read this bet slip.' },
          ],
        },
      ],
    });
  } catch (err) {
    throw friendlyError(err, Anthropic);
  }

  if (response.stop_reason === 'refusal') throw Object.assign(new Error("Claude couldn't read this image. Try the free reader or a different screenshot."), { status: 422 });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('The slip was too long to read in one go. Try fewer screenshots at a time.'), { status: 422 });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Claude's answer couldn't be read. Try again."), { status: 502 });
  }
  return toParsed(raw, catalog);
}

function friendlyError(err, Anthropic) {
  const is = (cls) => Anthropic && cls && err instanceof cls;
  if (Anthropic) {
    if (is(Anthropic.AuthenticationError) || is(Anthropic.PermissionDeniedError)) return Object.assign(new Error('Claude rejected the API key. Check it in Settings → Reading bet slip screenshots.'), { status: 400 });
    if (is(Anthropic.RateLimitError)) return Object.assign(new Error('Claude is busy or your API account hit its limit. Wait a minute and try again.'), { status: 429 });
    if (is(Anthropic.BadRequestError)) {
      if (/credit balance/i.test(err.message)) return Object.assign(new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com.'), { status: 402 });
      return Object.assign(new Error(`Claude couldn't use these images: ${err.message}`), { status: 400 });
    }
    if (is(Anthropic.APIConnectionError)) return Object.assign(new Error("Couldn't reach Claude. Check the internet connection and try again."), { status: 502 });
    if (is(Anthropic.APIError)) return Object.assign(new Error(`Claude responded with an error (${err.status}). Try again in a moment.`), { status: 502 });
  }
  return Object.assign(err, { status: err.status || 502 });
}

module.exports = { readSlip, toParsed, slipSchema, instructions, loadCatalog, checkImages, MODEL, MAX_IMAGES };
