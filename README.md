# 🎯 BetsFriend: Sports Betting Tracker

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
- **Auto-settle**: pending bets and parlay legs are graded from ESPN final scores and box scores. That covers moneylines, spreads, totals, team totals and player props (yards, receptions, TDs, points, rebounds, assists, combos like PRA and Rush + Rec, threes, double-doubles and more). The site checks when it opens and every 30 minutes, then shows a banner. You approve the results before anything changes. Props for players who didn't play are flagged for you to settle, since many books void them.
- **Player prop research**: 🔍 in the bet form, on player-prop parlay legs and on prop bet pages. It shows the player's last 10 games for that stat against your line, with hit rate, average, median, high/low, games against this opponent and a bar chart.
- **Insights**: your strengths and weaknesses in plain English ("You're 12-3 on NBA unders"). It breaks your record down by what you bet, prop category and side, day of week, sportsbook, favorites vs underdogs, odds range, bet size and straight vs parlay, and shows which legs sink your parlays.
- **Suggested bet sizes**: set a bankroll and unit size in Settings. The bet form then offers 0.5/1/2/3-unit buttons, an optional quarter-Kelly size from your own win estimate, and a warning when a bet is above your limit.
- **Game weather** (NFL): forecast at kickoff for outdoor stadiums (temperature, wind, gusts, chance of rain or snow) from Open-Meteo, with flags for wind, rain, snow, freezing and heat. Domes show as indoors, retractable roofs are noted, and neutral-site games are skipped.
- **Bet slip import** (**📷 Add from slip** on the Bets page): upload screenshots of a bet (up to 4 for a long parlay), drag them in, paste an image, or paste the confirmation text. The site reads the book, stake, odds, date and selections, including parlay legs, alternate lines and yes/no props, and pre-fills the bet form for you to check.
  - Screenshots are read for free in your browser (Tesseract text recognition, loaded the first time you use it).
  - For better accuracy on phone photos and unusual layouts, add a Claude API key in **Settings → Reading bet slip screenshots**, and Claude reads them instead. That costs a few cents per slip on your Anthropic account. If Claude can't read one, you can switch to the free reader with one click.
- **Phone access**: the computer running BetsFriend never needs a password. Other devices are blocked until you set one in **Settings → Phone access**, then sign in once; the login lasts 90 days and is limited to 10 tries per 15 minutes. Settings shows the address to open on your phone on the same Wi-Fi. For access away from home, Tailscale works without opening your network to the internet.
- **Rankings** tab (NFL, current regular season, built from ESPN box scores and refreshed hourly):
  - **Standings**: all eight divisions with W-L, win %, division record, points for/against, differential, streak and last 5. They're ordered by win %, then division record, conference record and point differential; the NFL's full tiebreakers aren't applied.
  - **Defense**: yards, points, pass and run yards allowed, yards per carry allowed, sacks, interceptions, fumbles recovered, takeaways, passing and rushing TDs allowed and 3rd-down %. Click any category to rank by it.
  - **Offense**: yards, points, passing, rushing, passing and rushing TDs, turnovers, yards per carry, sack rate allowed, 3rd-down % and an **O-line** ranking that blends pass protection (sack rate) and run blocking (yards per carry).
  - **Outliers**: games far from a team's other results that move its season average, for example a defense that allowed 3 points once but 28+ every other week. Each one shows the average and rank with and without that game, and how good the opponent was. Teams with an outlier are marked in the ranking tables.
- **Market** tab:
  - **Lines & splits**: every upcoming game with the opening line (from ESPN when available, otherwise the first line this site saw), the current line and how it has moved. With a free The Odds API key you also get the consensus across sportsbooks and the best available price per side. Enter public bet % and money % per game, or use **📋 Paste splits for all games**: paste a page or article (SportsBettingDime, VSIN, Action Network…) and the site reads every game's percentages from sentences or tables, for you to review before saving. Pasted or typed in, and the site flags bigger bets against the public, the public side and reverse line movement.
  - **Props**: with an Odds API key, consensus prop lines, best over/under prices and books, and how each line has moved since this site first saw it. Each prop has 🔍 research (last 10 games vs the line) and a + Bet button. Loading props for a game uses about 6 of the 500 free monthly requests and is cached for 6 hours.
  - **Streaks**: team ATS and over/under streaks, situational spots that apply this week (Sunday night, road underdog…) and player milestone streaks (e.g. "75+ rushing yards in 4 straight"). If prop lines are loaded, it also shows player streaks against those lines. Built in the background from ESPN box scores and cached for 3 hours.
- **Ask StatMuse**: StatMuse has no public API, so BetsFriend opens [StatMuse](https://www.statmuse.com) in a new tab with your question filled in. There's an **Ask StatMuse** box on Matchups, Rankings and every NFL/NBA team page, plus one-click questions on each game card (head-to-head, home/road record), in prop research (the player's stat over the last 10 games, vs this opponent and this season) and on each outlier card (game-by-game numbers).
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

You need [Node.js](https://nodejs.org) 18 or newer. `npm start` installs the one package BetsFriend needs (Anthropic's library, for reading slips with Claude) the first time it runs, and again whenever an update needs a newer version.

```bash
npm start
# → BetsFriend running at http://localhost:3000
```

Open http://localhost:3000 in your browser.

Optional environment variables:

| Variable    | Default         | Purpose                         |
|-------------|-----------------|---------------------------------|
| `PORT`      | `3000`          | Port to listen on               |
| `HOST`      | `0.0.0.0`       | Interface to bind               |
| `DATA_FILE` | `data/db.json`  | Where your bets and notes are saved |

Your data lives in `data/` (bets and notes in `db.json`, plus caches, backups and the phone-access password hash), which git ignores. Back it up from the **Backup** page.

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
lib/grading.js     Box-score parsing, prop stat mapping, bet grading, prop research summary
lib/weather.js     NFL stadium locations/roofs and Open-Meteo forecast summary
lib/auth.js        Password + sessions for access from other devices
lib/market.js      ESPN line parsing, Odds API consensus/best price, prop consensus
lib/trends.js      Team trends, player milestone streaks, streaks vs prop lines
public/            Frontend (vanilla JS, no build step)
  index.html
  app.js           Views: dashboard, bets, props, teams, injuries, notes, backup
  stats.js         Odds math, aggregations, bankroll/Kelly sizing, insights (shared with tests)
  slip.js          Bet slip text parser (shared with tests)
  splits.js        Betting-splits text parser for pasted articles/tables (shared with tests)
  teams.js         NFL/NBA team lists and prop categories
  styles.css       Light/dark theme
test/              node:test suites
```

### API

| Method | Path | |
|---|---|---|
| GET/POST | `/api/bets`, `/api/notes`, `/api/teamNotes`, `/api/coaches`, `/api/settings`, `/api/splits` | list / create |
| GET/PUT/DELETE | `/api/{collection}/{id}` | read / update / delete |
| GET | `/api/injuries/nfl`, `/api/injuries/nba` | injury report (`?refresh` skips the cache) |
| GET | `/api/schedule/nfl`, `/api/schedule/nba` | upcoming games (`?days=1-21`, `?refresh`) |
| GET | `/api/h2h/{nfl,nba}?a=KC&b=BUF` | previous meetings with leaders and storylines (`?n=1-10`) |
| GET | `/api/niche/{nfl,nba}?a=BUF&b=KC` | situational, ATS and O/U records for both teams (`?refresh`) |
| POST | `/api/autosettle` | grade pending picks from final results (nothing is saved) |
| GET | `/api/propresearch/{nfl,nba}?team=&player=&prop=&line=&side=&opp=` | player's recent games for a prop |
| GET | `/api/weather?home=GB&date=ISO` | NFL game-time forecast |
| GET/POST | `/api/auth/status`, `/api/auth/password`, `/api/auth/disable`, `/api/auth/logout` | phone access (changes only from this computer) |
| GET | `/api/market/{nfl,nba}?days=` | lines (open/now), consensus, best prices, entered splits (`?refresh` re-pulls odds) |
| GET | `/api/props/{nfl,nba}/{gameId}` | prop consensus for one game (`?refresh`) |
| GET | `/api/trends/{nfl,nba}?days=` | streaks & trends (builds in the background; poll until `status: ready`) |
| GET | `/api/version` | installed version |
| GET | `/api/update/check` | newest version on GitHub and what changed (`?refresh`) |
| POST | `/api/update/apply` | install a version (`{ "sha": "…" }`); restarts when run via `npm start` |
| GET | `/api/export` | full JSON backup |
| POST | `/api/import` | restore (replaces all data) |
