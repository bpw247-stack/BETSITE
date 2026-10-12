// NFL & NBA teams (abbreviations match ESPN) and suggested prop categories.
window.LEAGUES = {
  NFL: [
    ['ARI', 'Arizona Cardinals'], ['ATL', 'Atlanta Falcons'], ['BAL', 'Baltimore Ravens'], ['BUF', 'Buffalo Bills'],
    ['CAR', 'Carolina Panthers'], ['CHI', 'Chicago Bears'], ['CIN', 'Cincinnati Bengals'], ['CLE', 'Cleveland Browns'],
    ['DAL', 'Dallas Cowboys'], ['DEN', 'Denver Broncos'], ['DET', 'Detroit Lions'], ['GB', 'Green Bay Packers'],
    ['HOU', 'Houston Texans'], ['IND', 'Indianapolis Colts'], ['JAX', 'Jacksonville Jaguars'], ['KC', 'Kansas City Chiefs'],
    ['LV', 'Las Vegas Raiders'], ['LAC', 'Los Angeles Chargers'], ['LAR', 'Los Angeles Rams'], ['MIA', 'Miami Dolphins'],
    ['MIN', 'Minnesota Vikings'], ['NE', 'New England Patriots'], ['NO', 'New Orleans Saints'], ['NYG', 'New York Giants'],
    ['NYJ', 'New York Jets'], ['PHI', 'Philadelphia Eagles'], ['PIT', 'Pittsburgh Steelers'], ['SF', 'San Francisco 49ers'],
    ['SEA', 'Seattle Seahawks'], ['TB', 'Tampa Bay Buccaneers'], ['TEN', 'Tennessee Titans'], ['WSH', 'Washington Commanders'],
  ],
  NBA: [
    ['ATL', 'Atlanta Hawks'], ['BOS', 'Boston Celtics'], ['BKN', 'Brooklyn Nets'], ['CHA', 'Charlotte Hornets'],
    ['CHI', 'Chicago Bulls'], ['CLE', 'Cleveland Cavaliers'], ['DAL', 'Dallas Mavericks'], ['DEN', 'Denver Nuggets'],
    ['DET', 'Detroit Pistons'], ['GS', 'Golden State Warriors'], ['HOU', 'Houston Rockets'], ['IND', 'Indiana Pacers'],
    ['LAC', 'LA Clippers'], ['LAL', 'Los Angeles Lakers'], ['MEM', 'Memphis Grizzlies'], ['MIA', 'Miami Heat'],
    ['MIL', 'Milwaukee Bucks'], ['MIN', 'Minnesota Timberwolves'], ['NO', 'New Orleans Pelicans'], ['NY', 'New York Knicks'],
    ['OKC', 'Oklahoma City Thunder'], ['ORL', 'Orlando Magic'], ['PHI', 'Philadelphia 76ers'], ['PHX', 'Phoenix Suns'],
    ['POR', 'Portland Trail Blazers'], ['SAC', 'Sacramento Kings'], ['SA', 'San Antonio Spurs'], ['TOR', 'Toronto Raptors'],
    ['UTAH', 'Utah Jazz'], ['WSH', 'Washington Wizards'],
  ],
};

window.PROP_CATEGORIES = {
  NFL: [
    'Passing Yards', 'Passing TDs', 'Pass Completions', 'Pass Attempts', 'Interceptions Thrown', 'Rushing Yards',
    'Rushing Attempts', 'Receiving Yards', 'Receptions', 'Rush + Rec Yards', 'Longest Reception', 'Anytime TD',
    'First TD', '2+ TDs', 'Sacks', 'Tackles + Assists', 'Kicking Points', 'Field Goals Made', 'Team Total', 'First Half', 'Other',
  ],
  NBA: [
    'Points', 'Rebounds', 'Assists', 'Pts + Reb + Ast', 'Pts + Reb', 'Pts + Ast', 'Reb + Ast', '3-Pointers Made',
    'Steals', 'Blocks', 'Steals + Blocks', 'Turnovers', 'Double-Double', 'Triple-Double', 'First Basket',
    'Team Total', 'First Quarter', 'First Half', 'Other',
  ],
  Other: ['Other'],
};

window.BET_TYPES = ['Moneyline', 'Spread', 'Total', 'Player Prop', 'Game Prop', 'Parlay', 'Future', 'Other'];
window.PROP_TYPES = ['Player Prop', 'Game Prop'];
window.SIDES = ['', 'Over', 'Under', 'Yes', 'No'];
