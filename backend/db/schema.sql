CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    badge_url TEXT
);

CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    home_team_id TEXT REFERENCES teams(id),
    away_team_id TEXT REFERENCES teams(id),
    score_home INTEGER DEFAULT 0,
    score_away INTEGER DEFAULT 0,
    status TEXT DEFAULT 'NS',
    round INTEGER,
    match_date TEXT,
    match_time TEXT,
    venue TEXT,
    home_1h INTEGER DEFAULT 0,
    away_1h INTEGER DEFAULT 0,
    home_2h INTEGER DEFAULT 0,
    away_2h INTEGER DEFAULT 0,
    home_tries INTEGER DEFAULT 0,
    away_tries INTEGER DEFAULT 0,
    competition TEXT DEFAULT 'top14',
    match_clock TEXT DEFAULT '',
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS score_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT REFERENCES matches(id),
    team_id TEXT REFERENCES teams(id),
    player TEXT,
    event_type TEXT,
    minute INTEGER,
    half INTEGER DEFAULT 1,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
