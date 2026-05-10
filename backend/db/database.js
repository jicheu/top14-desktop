import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// In a packaged Electron app, ELECTRON_USER_DATA is injected by the main
// process so the DB persists in ~/Library/Application Support/top14-desktop.
// In dev (backend run standalone), fall back to the backend folder.
function resolveDbPath() {
  const userData = process.env.ELECTRON_USER_DATA;
  if (userData) {
    mkdirSync(userData, { recursive: true });
    return join(userData, 'top14.db');
  }
  return join(__dirname, '..', 'top14.db');
}

const DB_PATH = resolveDbPath();

let db;

export async function initDatabase() {
  const SQL = await initSqlJs();

  // Charger la base existante ou en créer une nouvelle
  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Exécuter le schéma
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.run(schema);

  // Migrations
  try {
    db.run("ALTER TABLE matches ADD COLUMN competition TEXT DEFAULT 'top14'");
    console.log("[DB] Migration: Colonne 'competition' ajoutée");
  } catch (err) {
    // Column already exists
  }

  try {
    db.run("ALTER TABLE matches ADD COLUMN home_tries INTEGER DEFAULT 0");
    console.log("[DB] Migration: Colonne 'home_tries' ajoutée");
  } catch (err) {
    // Column already exists
  }

  try {
    db.run("ALTER TABLE matches ADD COLUMN away_tries INTEGER DEFAULT 0");
    console.log("[DB] Migration: Colonne 'away_tries' ajoutée");
  } catch (err) {
    // Column already exists
  }

  try {
    db.run("ALTER TABLE matches ADD COLUMN match_clock TEXT DEFAULT ''");
    console.log("[DB] Migration: Colonne 'match_clock' ajoutée");
  } catch (err) {
    // Column already exists
  }

  // Sauvegarder périodiquement
  setInterval(() => saveDatabase(), 30_000);

  console.log('[DB] Base de données initialisée');
  return db;
}

export function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

export function getDb() {
  if (!db) {
    throw new Error("La base de données n'est pas initialisée. Appelez initDatabase() d'abord.");
  }
  return db;
}

// Helper: convertit le résultat sql.js en tableau d'objets
function queryAll(sql, params = []) {
  const stmt = getDb().prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function runSql(sql, params = []) {
  const stmt = getDb().prepare(sql);
  if (params.length) stmt.bind(params);
  stmt.step();
  stmt.free();
}

// --- Teams ---

export function upsertTeam(team) {
  runSql(`
    INSERT OR REPLACE INTO teams (id, name, badge_url)
    VALUES (?, ?, ?)
  `, [team.id, team.name, team.badge_url]);
}

export function getAllTeams() {
  return queryAll('SELECT * FROM teams');
}

// --- Matches ---

export function upsertMatch(match) {
  runSql(`
    INSERT OR REPLACE INTO matches (id, home_team_id, away_team_id, score_home, score_away, status, round, match_date, match_time, venue, home_1h, away_1h, home_2h, away_2h, home_tries, away_tries, competition, match_clock, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    match.id, match.home_team_id, match.away_team_id,
    match.score_home, match.score_away, match.status,
    match.round, match.match_date, match.match_time, match.venue,
    match.home_1h, match.away_1h, match.home_2h, match.away_2h,
    match.home_tries || 0, match.away_tries || 0,
    match.competition || 'top14',
    match.match_clock || '',
    match.updated_at
  ]);
}

export function getMatch(id) {
  return queryOne(`
    SELECT m.*,
      ht.name as home_team_name, ht.badge_url as home_team_badge,
      at2.name as away_team_name, at2.badge_url as away_team_badge
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at2 ON m.away_team_id = at2.id
    WHERE m.id = ?
  `, [id]);
}

export function getAllMatches(competition, round, date) {
  let sql = `
    SELECT m.*,
      ht.name as home_team_name, ht.badge_url as home_team_badge,
      at2.name as away_team_name, at2.badge_url as away_team_badge
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at2 ON m.away_team_id = at2.id
  `;
  const params = [];
  const conditions = [];
  
  if (competition) {
    conditions.push(`m.competition = ?`);
    params.push(competition);
  }

  if (round) {
    conditions.push(`m.round = ?`);
    params.push(round);
  }

  if (date) {
    conditions.push(`m.match_date = ?`);
    params.push(date);
  }
  
  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }
  
  sql += ` ORDER BY m.match_date ASC, m.match_time ASC`;
  
  return queryAll(sql, params);
}

export function getCompetitionRounds(competition) {
  const sql = `SELECT DISTINCT round FROM matches WHERE competition = ? ORDER BY round ASC`;
  const results = queryAll(sql, [competition]);
  return results.map(r => r.round);
}

export function getCompetitionDates(competition) {
  const results = queryAll(
    `SELECT DISTINCT match_date FROM matches WHERE competition = ? AND match_date IS NOT NULL AND match_date != '' ORDER BY match_date ASC`,
    [competition]
  );
  return results.map(r => r.match_date);
}

export function getRecommendedDate(competition) {
  const today = new Date().toISOString().split('T')[0];

  // 1. Date with a live match
  const live = queryOne(
    `SELECT DISTINCT match_date FROM matches WHERE competition = ? AND status IN ('1H','HT','2H','Started') ORDER BY match_date DESC LIMIT 1`,
    [competition]
  );
  if (live) return live.match_date;

  // 2. Today
  const todayRow = queryOne(
    `SELECT DISTINCT match_date FROM matches WHERE competition = ? AND match_date = ? LIMIT 1`,
    [competition, today]
  );
  if (todayRow) return todayRow.match_date;

  // 3. Most recent finished date
  const lastFinished = queryOne(
    `SELECT DISTINCT match_date FROM matches WHERE competition = ? AND status IN ('FT','Match Finished') ORDER BY match_date DESC LIMIT 1`,
    [competition]
  );
  if (lastFinished) return lastFinished.match_date;

  // 4. Earliest upcoming
  const next = queryOne(
    `SELECT DISTINCT match_date FROM matches WHERE competition = ? AND match_date > ? ORDER BY match_date ASC LIMIT 1`,
    [competition, today]
  );
  if (next) return next.match_date;

  // 5. Any date
  const any = queryOne(
    `SELECT DISTINCT match_date FROM matches WHERE competition = ? ORDER BY match_date DESC LIMIT 1`,
    [competition]
  );
  return any ? any.match_date : null;
}

export function getRecommendedRound(competition) {
  // 1. Chercher un round avec des matchs en direct (toutes compétitions confondues)
  // car 'Started' ou d'autres statuts peuvent être utilisés
  const liveRound = queryOne(`
    SELECT DISTINCT round FROM matches 
    WHERE competition = ? AND status IN ('1H', 'HT', '2H', 'Started')
    LIMIT 1
  `, [competition]);
  
  if (liveRound) return liveRound.round;

  // 2. Chercher le round avec des matchs aujourd'hui
  const today = new Date().toISOString().split('T')[0];
  const todayRound = queryOne(`
    SELECT DISTINCT round FROM matches
    WHERE competition = ? AND match_date = ?
    LIMIT 1
  `, [competition, today]);

  if (todayRound) return todayRound.round;

  // 3. Chercher le dernier round terminé
  const lastFinishedRound = queryOne(`
    SELECT DISTINCT round FROM matches 
    WHERE competition = ? AND status IN ('FT', 'Match Finished')
    ORDER BY round DESC
    LIMIT 1
  `, [competition]);

  if (lastFinishedRound) return lastFinishedRound.round;

  // 4. Fallback sur le round le plus élevé (ou le premier dispo)
  const fallbackRound = queryOne(`
    SELECT DISTINCT round FROM matches 
    WHERE competition = ?
    ORDER BY round DESC
    LIMIT 1
  `, [competition]);

  return fallbackRound ? fallbackRound.round : null;
}

export function getLiveMatches(competition) {
  let sql = `
    SELECT m.*,
      ht.name as home_team_name, ht.badge_url as home_team_badge,
      at2.name as away_team_name, at2.badge_url as away_team_badge
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at2 ON m.away_team_id = at2.id
    WHERE m.status IN ('1H', 'HT', '2H')
  `;
  const params = [];

  if (competition) {
    sql += ` AND m.competition = ?`;
    params.push(competition);
  }

  sql += ` ORDER BY m.match_date ASC, m.match_time ASC`;

  return queryAll(sql, params);
}

// --- Standings ---

export function getStandings(competition) {
  const matches = getAllMatches(competition);
  const standings = {};

  // Only count finished matches
  const finishedMatches = matches.filter(m => ['FT', 'Match Finished'].includes(m.status));

  if (finishedMatches.length === 0) {
    console.warn(`[DB] No finished matches for ${competition}, returning empty standings`);
    return [];
  }

  finishedMatches.forEach(m => {
    if (!standings[m.home_team_id]) {
      standings[m.home_team_id] = { 
        id: m.home_team_id, 
        name: m.home_team_name, 
        badge_url: m.home_team_badge,
        played: 0, won: 0, drawn: 0, lost: 0, 
        pointsFor: 0, pointsAgainst: 0, diff: 0, 
        points: 0,
        bonusOffensive: 0,
        bonusDefensive: 0
      };
    }
    if (!standings[m.away_team_id]) {
      standings[m.away_team_id] = { 
        id: m.away_team_id, 
        name: m.away_team_name, 
        badge_url: m.away_team_badge,
        played: 0, won: 0, drawn: 0, lost: 0, 
        pointsFor: 0, pointsAgainst: 0, diff: 0, 
        points: 0,
        bonusOffensive: 0,
        bonusDefensive: 0
      };
    }

    const home = standings[m.home_team_id];
    const away = standings[m.away_team_id];

    home.played++;
    away.played++;
    home.pointsFor += m.score_home;
    home.pointsAgainst += m.score_away;
    away.pointsFor += m.score_away;
    away.pointsAgainst += m.score_home;

    if (m.score_home > m.score_away) {
      // Home wins
      home.won++;
      home.points += 4;
      away.lost++;

      // Bonus Offensif
      // Top 14: 3+ tries more than opponent
      // Other leagues: 4+ tries scored
      if (competition === 'top14') {
        if (m.home_tries - m.away_tries >= 3) {
          home.points += 1;
          home.bonusOffensive++;
        }
      } else {
        if (m.home_tries >= 4) {
          home.points += 1;
          home.bonusOffensive++;
        }
      }

      // Bonus Défensif (losing team, within 7 points for most leagues, 5 for Top 14)
      const defensiveMargin = competition === 'top14' ? 5 : 7;
      if (m.score_home - m.score_away <= defensiveMargin) {
        away.points += 1;
        away.bonusDefensive++;
      }
    } else if (m.score_home < m.score_away) {
      // Away wins
      away.won++;
      away.points += 4;
      home.lost++;

      // Bonus Offensif
      if (competition === 'top14') {
        if (m.away_tries - m.home_tries >= 3) {
          away.points += 1;
          away.bonusOffensive++;
        }
      } else {
        if (m.away_tries >= 4) {
          away.points += 1;
          away.bonusOffensive++;
        }
      }

      // Bonus Défensif
      const defensiveMargin = competition === 'top14' ? 5 : 7;
      if (m.score_away - m.score_home <= defensiveMargin) {
        home.points += 1;
        home.bonusDefensive++;
      }
    } else {
      // Draw
      home.drawn++;
      away.drawn++;
      home.points += 2;
      away.points += 2;

      // Bonus Offensif in draws (for non-Top 14)
      if (competition !== 'top14') {
        if (m.home_tries >= 4) {
          home.points += 1;
          home.bonusOffensive++;
        }
        if (m.away_tries >= 4) {
          away.points += 1;
          away.bonusOffensive++;
        }
      }
    }

    home.diff = home.pointsFor - home.pointsAgainst;
    away.diff = away.pointsFor - away.pointsAgainst;
  });

  // Sort by points, then diff, then points for
  const sortedStandings = Object.values(standings).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.diff !== a.diff) return b.diff - a.diff;
    return b.pointsFor - a.pointsFor;
  });

  console.log(`[DB] Calculated standings for ${competition} from ${finishedMatches.length} matches`);
  return sortedStandings;
}

// --- Score Events ---

export function insertScoreEvent(event) {
  runSql(`
    INSERT INTO score_events (match_id, team_id, player, event_type, minute, half, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [event.match_id, event.team_id, event.player, event.event_type, event.minute, event.half, event.detail]);
}

export function getScoreEvents(matchId) {
  return queryAll(`
    SELECT se.*, t.name as team_name, t.badge_url as team_badge
    FROM score_events se
    JOIN teams t ON se.team_id = t.id
    WHERE se.match_id = ?
    ORDER BY se.minute ASC
  `, [matchId]);
}

export function clearScoreEvents(matchId) {
  runSql('DELETE FROM score_events WHERE match_id = ?', [matchId]);
}

// --- Team form ---

/**
 * Returns the last `limit` finished matches for a team in a given competition.
 * Each row includes home/away team names and badge URLs.
 */
export function getTeamRecentMatches(teamId, competition, limit = 5) {
  return queryAll(`
    SELECT m.*,
      ht.name  AS home_team_name, ht.badge_url  AS home_team_badge,
      at2.name AS away_team_name, at2.badge_url AS away_team_badge
    FROM matches m
    JOIN teams ht  ON m.home_team_id = ht.id
    JOIN teams at2 ON m.away_team_id = at2.id
    WHERE (m.home_team_id = ? OR m.away_team_id = ?)
      AND m.competition = ?
      AND m.status IN ('FT', 'Match Finished')
    ORDER BY m.match_date DESC, m.match_time DESC
    LIMIT 5
  `, [teamId, teamId, competition]);
}
