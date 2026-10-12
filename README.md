# 🎯 BetSite: Sports Betting Tracker

A personal website for tracking your sports bets: picks, money placed, wins and losses, success rate by prop type and by team, live NFL and NBA injury reports, and notes everywhere.

## Features

- **Bet tracking**: log moneylines, spreads, totals, player props, game props, parlays and futures. Each bet records the sport, team, opponent, player, prop category, side (Over/Under/Yes/No), line, American odds, stake, sportsbook and result. The site works out the payout, and you can override P/L by hand for cash-outs, boosts or free bets.
- **Parlay legs**: when you choose Parlay, you add each leg (moneyline, spread, total or prop, from any league) with its own odds and result. The parlay's overall result comes from its legs: one losing leg loses it, and a pushed leg drops out with the payout reduced. Combined odds are filled in automatically from the legs' odds. Every leg also counts toward that team's, player's and prop's success rate. The parlay's money counts only toward the parlay itself.
- **Quick settle**: mark pending bets Won, Lost or Push with one click.
- **Dashboard**: net profit, W-L-P record, win rate, ROI, money at risk, current streak and a running profit/loss chart you can hover. It also has breakdowns by team, prop, bet type and sport.
- **Prop success rates**: by prop category (Passing Yards, Points, PRA…), by side, by category × side and by player.
- **Team success rates**: record, win %, money staked, P/L and ROI for every team you've backed, and for teams you've bet *against*. Each team has its own page with its bets, live injuries and notes.
- **Matchups**: upcoming NFL or NBA games (today, or the next 3, 7 or 14 days) with kickoff/tip time, TV, records, the betting line and over/under, and live scores. Each game lists its notable injuries. For the NFL that's every QB plus RB/WR/TE not on a season-long list, and for the NBA it's anyone out, doubtful, questionable or day-to-day; a toggle shows all injuries. NFL weeks also get a **QB watch** table. Games you have pending bets or parlay legs on are highlighted, and each game has buttons to log a bet on either team with the matchup pre-filled.
- **Previous matchups** (on every Matchups game card): the last 5 meetings between the two teams over recent seasons, playoffs included. You get the series record, average total points compared with this game's over/under, and average margin. Each game is tagged with storylines: 💥 blowouts, ⏱️ close games, ⚡ offensive dominance (35+ pts or 450+ yds in the NFL; 130+ pts or 55%+ FG in the NBA) and 🛡️ defensive dominance (allowed 10 or fewer pts, or forced 3+ turnovers; 95 or fewer pts in the NBA). 🔥 marks big individual games: 300+ passing yards or 3+ TD passes, 100+ rushing or receiving yards, or 2+ TDs; 30+ points, 15+ rebounds or 10+ assists in the NBA.
- **Niche Stats** (📊 button on every Matchups game): side-by-side situational records for both teams over the last four NFL seasons (two in the NBA). For the NFL that's overall, home/away, primetime (7 PM ET or later), Monday, Thursday and Sunday night, division games, after a loss or win, playoffs and the last 10. The NBA gets national-TV games and the second night of back-to-backs instead of the night-game rows. It also shows the record against the spread (overall, as favorite or underdog, home/away, primetime, last 10) and the over/under record, worked out from ESPN's closing lines. Rows that apply to this game are highlighted, for example Monday Night for an MNF game or underdog for the team getting points. Head coaches come from ESPN. You can add coordinators and assistants with their previous teams, and the site flags anyone who used to work for the opponent and any former team the two staffs share.
- **Injury reports**: live NFL and NBA injury lists from ESPN's public feed, cached for 15 minutes. You can filter by team, status or player, or show only teams you've bet on. Teams with pending bets are highlighted, and injuries also appear on each bet and team page.
- **Notes**:
  - A **general notes** page with titles, tags, pinning and search.
  - A **notes log on every bet** with timestamps, edit and delete.
  - A **notes log on every team** (works before you've bet on the team).
  - The Notes page also shows a searchable feed of all bet and team notes.
- **Backup**: export everything as JSON, restore from a backup, or download your bets as CSV.
- **One-click updates**: the site checks GitHub for new versions (on start and every 3 hours). When one exists, a banner offers **Update now**, and **Settings** shows what's new. Updating backs up `data/db.json` to `data/backups/`, installs the new code without touching `data/`, and restarts the site automatically.
- **Auto-refresh**: while the site is open, injuries refresh every 15 minutes and schedules every 10 minutes. During live games they refresh every minute. The page redraws quietly, and waits if you're typing or have a form open.

## Running it

You need [Node.js](https://nodejs.org) 18 or newer. There are no dependencies to install.

```bash
npm start
# → BetSite running at http://localhost:3000
```

Open http://localhost:3000 in your browser.

Optional environment variables:

| Variable    | Default         | Purpose                         |
|-------------|-----------------|---------------------------------|
| `PORT`      | `3000`          | Port to listen on               |
| `HOST`      | `0.0.0.0`       | Interface to bind               |
| `DATA_FILE` | `data/db.json`  | Where your bets and notes are saved |

Your data lives in `data/db.json`, which git ignores. Back it up from the **Backup** page.

> **Note:** the site has no login. Run it on your own computer, or put it behind authentication before you expose it on the internet.

## Tests

```bash
npm test
```

## Project layout

```
start.js           Launcher used by `npm start`; restarts server.js after an in-app update
server.js          HTTP server: static files, JSON storage, REST API, ESPN proxies, updater endpoints
lib/injuries.js    Normalizes ESPN's injury feed
lib/schedule.js    Normalizes ESPN's scoreboard (upcoming games)
lib/h2h.js         Past meetings, box-score leaders and notable-performance rules
lib/updater.js     Checks GitHub for new versions and installs them (never touches data/)
lib/unzip.js       Tiny dependency-free ZIP reader used by the updater
lib/niche.js       Situational splits, primetime slots (US Eastern), ATS / O-U from closing lines
public/            Frontend (vanilla JS, no build step)
  index.html
  app.js           Views: dashboard, bets, props, teams, injuries, notes, backup
  stats.js         Odds math and aggregations (shared with tests)
  teams.js         NFL/NBA team lists and prop categories
  styles.css       Light/dark theme
test/              node:test suites
```

### API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/bets`, `/api/notes`, `/api/teamNotes`, `/api/coaches` | list / create |
| GET/PUT/DELETE | `/api/{collection}/{id}` | read / update / delete |
| GET | `/api/injuries/nfl`, `/api/injuries/nba` | injury report (`?refresh` skips the cache) |
| GET | `/api/schedule/nfl`, `/api/schedule/nba` | upcoming games (`?days=1-21`, `?refresh`) |
| GET | `/api/h2h/{nfl,nba}?a=KC&b=BUF` | previous meetings with leaders and storylines (`?n=1-10`) |
| GET | `/api/niche/{nfl,nba}?a=BUF&b=KC` | situational, ATS and O/U records for both teams (`?refresh`) |
| GET | `/api/version` | installed version |
| GET | `/api/update/check` | newest version on GitHub and what changed (`?refresh`) |
| POST | `/api/update/apply` | install a version (`{ "sha": "…" }`); restarts when run via `npm start` |
| GET | `/api/export` | full JSON backup |
| POST | `/api/import` | restore (replaces all data) |
