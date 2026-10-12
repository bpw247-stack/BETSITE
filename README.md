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
- **Injury reports**: live NFL and NBA injury lists from ESPN's public feed, cached for 15 minutes. You can filter by team, status or player, or show only teams you've bet on. Teams with pending bets are highlighted, and injuries also appear on each bet and team page.
- **Notes**:
  - A **general notes** page with titles, tags, pinning and search.
  - A **notes log on every bet** with timestamps, edit and delete.
  - A **notes log on every team** (works before you've bet on the team).
  - The Notes page also shows a searchable feed of all bet and team notes.
- **Backup**: export everything as JSON, restore from a backup, or download your bets as CSV.

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
server.js          HTTP server: static files, JSON storage, REST API, injury proxy
lib/injuries.js    Normalizes ESPN's injury feed
lib/schedule.js    Normalizes ESPN's scoreboard (upcoming games)
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
| GET/POST | `/api/bets`, `/api/notes`, `/api/teamNotes` | list / create |
| GET/PUT/DELETE | `/api/{collection}/{id}` | read / update / delete |
| GET | `/api/injuries/nfl`, `/api/injuries/nba` | injury report (`?refresh` skips the cache) |
| GET | `/api/schedule/nfl`, `/api/schedule/nba` | upcoming games (`?days=1-21`, `?refresh`) |
| GET | `/api/export` | full JSON backup |
| POST | `/api/import` | restore (replaces all data) |
