'use strict';

// Game-time weather for NFL games from Open-Meteo (free, no API key).
// Stadium locations/roofs by home team; neutral-site games are skipped.

const STADIUMS = {
  ARI: { name: 'State Farm Stadium', lat: 33.5276, lon: -112.2626, roof: 'retractable' },
  ATL: { name: 'Mercedes-Benz Stadium', lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  BAL: { name: 'M&T Bank Stadium', lat: 39.278, lon: -76.6227, roof: 'open' },
  BUF: { name: 'Highmark Stadium', lat: 42.7738, lon: -78.787, roof: 'open' },
  CAR: { name: 'Bank of America Stadium', lat: 35.2258, lon: -80.8528, roof: 'open' },
  CHI: { name: 'Soldier Field', lat: 41.8623, lon: -87.6167, roof: 'open' },
  CIN: { name: 'Paycor Stadium', lat: 39.0955, lon: -84.5161, roof: 'open' },
  CLE: { name: 'Huntington Bank Field', lat: 41.5061, lon: -81.6995, roof: 'open' },
  DAL: { name: 'AT&T Stadium', lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  DEN: { name: 'Empower Field at Mile High', lat: 39.7439, lon: -105.0201, roof: 'open' },
  DET: { name: 'Ford Field', lat: 42.34, lon: -83.0456, roof: 'dome' },
  GB: { name: 'Lambeau Field', lat: 44.5013, lon: -88.0622, roof: 'open' },
  HOU: { name: 'NRG Stadium', lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  IND: { name: 'Lucas Oil Stadium', lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  JAX: { name: 'EverBank Stadium', lat: 30.3239, lon: -81.6373, roof: 'open' },
  KC: { name: 'GEHA Field at Arrowhead', lat: 39.0489, lon: -94.4839, roof: 'open' },
  LV: { name: 'Allegiant Stadium', lat: 36.0909, lon: -115.1833, roof: 'dome' },
  LAC: { name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LAR: { name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, roof: 'dome' },
  MIA: { name: 'Hard Rock Stadium', lat: 25.958, lon: -80.2389, roof: 'open' },
  MIN: { name: 'U.S. Bank Stadium', lat: 44.9737, lon: -93.2577, roof: 'dome' },
  NE: { name: 'Gillette Stadium', lat: 42.0909, lon: -71.2643, roof: 'open' },
  NO: { name: 'Caesars Superdome', lat: 29.9511, lon: -90.0812, roof: 'dome' },
  NYG: { name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, roof: 'open' },
  NYJ: { name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, roof: 'open' },
  PHI: { name: 'Lincoln Financial Field', lat: 39.9008, lon: -75.1675, roof: 'open' },
  PIT: { name: 'Acrisure Stadium', lat: 40.4468, lon: -80.0158, roof: 'open' },
  SF: { name: "Levi's Stadium", lat: 37.403, lon: -121.97, roof: 'open' },
  SEA: { name: 'Lumen Field', lat: 47.5952, lon: -122.3316, roof: 'open' },
  TB: { name: 'Raymond James Stadium', lat: 27.9759, lon: -82.5033, roof: 'open' },
  TEN: { name: 'Nissan Stadium', lat: 36.1665, lon: -86.7713, roof: 'open' },
  WSH: { name: 'Northwest Stadium', lat: 38.9077, lon: -76.8645, roof: 'open' },
};

const CONDITIONS = [
  [[0], 'Clear'], [[1, 2], 'Partly cloudy'], [[3], 'Cloudy'], [[45, 48], 'Fog'],
  [[51, 53, 55, 56, 57], 'Drizzle'], [[61, 63, 65, 66, 67], 'Rain'], [[71, 73, 75, 77], 'Snow'],
  [[80, 81, 82], 'Showers'], [[85, 86], 'Snow showers'], [[95, 96, 99], 'Thunderstorms'],
];
const conditionText = (code) => (CONDITIONS.find(([codes]) => codes.includes(Number(code))) || [null, ''])[1];
const isSnow = (code) => [71, 73, 75, 77, 85, 86].includes(Number(code));

function forecastUrl(stadium, kickoffIso) {
  const start = new Date(kickoffIso);
  const end = new Date(start.getTime() + 4 * 3600 * 1000);
  const day = (d) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: stadium.lat,
    longitude: stadium.lon,
    hourly: 'temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'GMT',
    start_date: day(start),
    end_date: day(end),
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

// Summarize the game window (kickoff to +3h) from an Open-Meteo hourly payload.
function summarizeForecast(json, kickoffIso) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return null;
  const k = Date.parse(kickoffIso);
  const idx = h.time
    .map((t, i) => ({ i, t: Date.parse(t.endsWith('Z') ? t : t + 'Z') }))
    .filter(({ t }) => t >= k - 30 * 60000 && t <= k + 3 * 3600000)
    .map(({ i }) => i);
  if (!idx.length) return null;
  const pick = (arr) => idx.map((i) => (arr || [])[i]).filter((v) => v != null);
  const max = (arr) => (pick(arr).length ? Math.max(...pick(arr)) : null);
  const first = (arr) => (pick(arr).length ? pick(arr)[0] : null);
  const codes = pick(h.weather_code);
  const worst = codes.length ? Math.max(...codes) : null; // higher WMO codes are generally worse
  const out = {
    temp: first(h.temperature_2m) != null ? Math.round(first(h.temperature_2m)) : null,
    wind: max(h.wind_speed_10m) != null ? Math.round(max(h.wind_speed_10m)) : null,
    gust: max(h.wind_gusts_10m) != null ? Math.round(max(h.wind_gusts_10m)) : null,
    precipChance: max(h.precipitation_probability),
    precip: max(h.precipitation),
    condition: conditionText(worst),
    flags: [],
  };
  if ((out.wind != null && out.wind >= 15) || (out.gust != null && out.gust >= 25)) out.flags.push({ type: 'wind', text: 'Windy: can hurt passing and kicking' });
  if (isSnow(worst)) out.flags.push({ type: 'snow', text: 'Snow' });
  else if ((out.precipChance != null && out.precipChance >= 50) || (out.precip != null && out.precip >= 0.1)) out.flags.push({ type: 'rain', text: 'Rain likely' });
  if (out.temp != null && out.temp <= 32) out.flags.push({ type: 'cold', text: 'Freezing' });
  if (out.temp != null && out.temp >= 90) out.flags.push({ type: 'heat', text: 'Hot' });
  return out;
}

module.exports = { STADIUMS, forecastUrl, summarizeForecast, conditionText };
