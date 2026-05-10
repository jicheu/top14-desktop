import { DataProvider } from './DataProvider.js';

// No-op fallback
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';
const ESPN_STANDINGS_BASE = 'https://site.api.espn.com/apis/v2/sports/rugby';

/**
 * ESPN league IDs for each competition key.
 * NOTE: Top14 is excluded here — it is handled by LnrProvider.
 */
const LEAGUE_MAP = {
  'premiership':         { id: '267979',  name: 'Gallagher Premiership',          playoffCount: 4 },
  'urc':                 { id: '270557',  name: 'United Rugby Championship',       playoffCount: 8 },
  'super_rugby':         { id: '242041',  name: 'Super Rugby Pacific',             playoffCount: 4 },
  'champions_cup':       { id: '271937',  name: 'European Rugby Champions Cup',    playoffCount: 0 },
  'challenge_cup':       { id: '272073',  name: 'European Rugby Challenge Cup',    playoffCount: 0 },
  'six_nations_male':    { id: '180659',  name: 'Six Nations',                     playoffCount: 0 },
  'rugby_championship':  { id: '244293',  name: 'The Rugby Championship',          playoffCount: 0 },
};

const STATUS_MAP = {
  // Finished
  'STATUS_FINAL':          'FT',
  'STATUS_FULL_TIME':      'FT',
  'STATUS_END_OF_GAME':    'FT',
  // Live
  'STATUS_IN_PROGRESS':    '1H',
  'STATUS_FIRST_HALF':     '1H',
  'STATUS_SECOND_HALF':    '2H',
  'STATUS_OVERTIME':       '2H',
  'STATUS_HALFTIME':       'HT',
  'STATUS_END_PERIOD':     'HT',
  // Pre-match
  'STATUS_SCHEDULED':      'NS',
  'STATUS_TBD':            'NS',
  // Misc
  'STATUS_POSTPONED':      'PST',
  'STATUS_CANCELED':       'CANC',
  'STATUS_SUSPENDED':      'PST',
};

// ESPN event type text → internal type
const ESPN_EVENT_TYPE_MAP = {
  'try':           'essai',
  'conversion':    'transformation',
  'penalty goal':  'penalite',
  'drop goal':     'drop',
  'yellow card':   'carton_jaune',
  'red card':      'carton_rouge',
};

// Only these event types appear in the scoring summary
const SCORING_TYPES = new Set(Object.keys(ESPN_EVENT_TYPE_MAP));

export class EspnProvider extends DataProvider {
  constructor() {
    super();
    this.previousScores = new Map();
  }

  async fetchTeams() {
    // Teams are extracted as a side-effect of fetchMatches
    return [];
  }

  async fetchMatches() {
    let allMatches = [];
    let allChanges = [];

    // Rolling window: 5 weeks back → 2 weeks ahead, formatted as YYYYMMDD-YYYYMMDD
    const fmt = d => d.toISOString().split('T')[0].replace(/-/g, '');
    const now = new Date();
    const windowStart = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000); // 5 weeks ago
    const windowEnd   = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 2 weeks ahead
    const dateRange   = `${fmt(windowStart)}-${fmt(windowEnd)}`;

    for (const [compKey, league] of Object.entries(LEAGUE_MAP)) {
      try {
        // Fetch the rolling window (includes current + recent + upcoming)
        const rangeEvents   = await this._fetchScoreboard(league.id, dateRange);
        // Also fetch the bare scoreboard (catches live matches ESPN might omit from range)
        const currentEvents = await this._fetchScoreboard(league.id);

        // Merge, deduplicate by event id (current overwrites range for live data)
        const seen = new Set();
        const merged = [];
        for (const e of [...currentEvents, ...rangeEvents]) {
          if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
        }

        const matches = merged.map(e => this._normalizeEvent(e, compKey)).filter(Boolean);

        console.log(`[ESPN] ${compKey}: ${matches.length} matches (${new Set(matches.map(m => m.match_date)).size} dates)`);

        for (const match of matches) {
          const prev = this.previousScores.get(match.id);
          const scoreStr = `${match.score_home}-${match.score_away}`;
          if (prev && prev !== scoreStr) {
            allChanges.push({ type: 'score', match });
          }
          this.previousScores.set(match.id, scoreStr);
        }

        // Extract and store scoring events for live/finished matches
        for (const rawEvent of merged) {
          const matchId = `espn-${rawEvent.id}`;
          const comp = (rawEvent.competitions || [])[0];
          if (!comp) continue;
          const scoreEvents = this._extractScoringEvents(comp, matchId);
          if (scoreEvents.length > 0) {
            allChanges.push({ type: 'events_full', events: scoreEvents });
          }
        }

        allMatches = allMatches.concat(matches);

        // Small delay to avoid hammering ESPN
        await delay(300);
      } catch (err) {
        console.error(`[ESPN] Error fetching ${compKey}:`, err.message);
      }
    }

    return { matches: allMatches, changes: allChanges };
  }

  async fetchScoreEvents(_matchId) {
    // ESPN doesn't provide granular scoring timeline on free tier
    return [];
  }

  /**
   * Fetch official standings from ESPN for a competition.
   * For Top14, computes standings from scoreboard events (ESPN's standings endpoint
   * returns stale/last-season data for Top14). For other competitions uses ESPN standings API.
   * Returns an array ordered by rank with all stats.
   */
  async fetchStandings(compKey) {
    if (compKey === 'top14') {
      return this._computeTop14Standings();
    }

    const leagueId = LEAGUE_MAP[compKey]?.id;
    if (!leagueId) return null;

    try {
      const url = `${ESPN_STANDINGS_BASE}/${leagueId}/standings`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const children = data.children || [];
      if (children.length === 0) return null;

      // Use the first group's entries
      const entries = children[0]?.standings?.entries || [];
      if (entries.length === 0) return null;

      return entries.map((entry, index) => {
        const team = entry.team || {};
        const stats = {};
        for (const s of (entry.stats || [])) {
          stats[s.name] = s.value ?? parseFloat(s.displayValue) ?? 0;
        }

        return {
          rank: Math.round(stats.rank ?? index + 1),
          id: `espn-${team.id}`,
          name: team.displayName || team.name || '?',
          badge_url: team.logos?.[0]?.href || team.logo || '',
          played:        Math.round(stats.gamesPlayed ?? 0),
          won:           Math.round(stats.gamesWon    ?? 0),
          drawn:         Math.round(stats.gamesDrawn  ?? 0),
          lost:          Math.round(stats.gamesLost   ?? 0),
          pointsFor:     Math.round(stats.pointsFor   ?? 0),
          pointsAgainst: Math.round(stats.pointsAgainst ?? 0),
          diff:          Math.round(stats.pointsDifference ?? stats.differential ?? 0),
          triesFor:      Math.round(stats.triesFor    ?? 0),
          triesAgainst:  Math.round(stats.triesAgainst ?? 0),
          bonusOffensive:Math.round(stats.bonusPointsTry  ?? 0),
          bonusDefensive:Math.round(stats.bonusPointsLosing ?? 0),
          bonusPoints:   Math.round(stats.bonusPoints  ?? 0),
          points:        Math.round(stats.points       ?? 0),
        };
      }).sort((a, b) => a.rank - b.rank);
    } catch (err) {
      console.error(`[ESPN] Error fetching standings for ${compKey}:`, err.message);
      return null;
    }
  }

  /**
   * Compute Top14 standings from ESPN scoreboard events.
   * ESPN's standings endpoint returns stale (last-season) data for Top14, so instead we
   * fetch all this-season's match events via date-range scoreboard queries and compute
   * the table ourselves, including bonus points.
   *
   * Top14 bonus rules:
   *  - Offensive bonus: winner/scorer scores 3+ more tries than opponent
   *  - Defensive bonus: losing team loses by 5 points or fewer
   */
  async _computeTop14Standings() {
    const TOP14_ID = '270559';
    const now = new Date();

    // Determine the current season date range (season starts in August/September)
    const seasonEndYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
    const seasonStart = `${seasonEndYear - 1}0801`;
    const seasonEnd   = `${seasonEndYear}0731`;

    // Fetch in two batches to get the full season (ESPN returns max ~100 events per request)
    const midYear = `${seasonEndYear - 1}1231`;
    const batchUrls = [
      `${ESPN_BASE}/${TOP14_ID}/scoreboard?dates=${seasonStart}-${midYear}`,
      `${ESPN_BASE}/${TOP14_ID}/scoreboard?dates=${String(seasonEndYear).padStart(4,'0')}0101-${seasonEnd}`,
    ];

    let allEvents = [];
    for (const url of batchUrls) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        const batch = data.events || [];
        allEvents = allEvents.concat(batch);
        console.log(`[ESPN] Top14 standings batch: ${batch.length} events`);
      } catch (err) {
        console.error('[ESPN] Error fetching Top14 scoreboard batch:', err.message);
      }
    }

    if (allEvents.length === 0) return null;

    // Deduplicate events (batches may overlap at batch boundaries)
    const seen = new Set();
    const uniqueEvents = allEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    // Build standings map: teamId → stats
    const standings = new Map();

    const getOrCreate = (team) => {
      const id = `espn-${team.id}`;
      if (!standings.has(id)) {
        standings.set(id, {
          id,
          name: team.displayName || team.name,
          badge_url: team.logos?.[0]?.href || team.logo || '',
          played: 0, won: 0, drawn: 0, lost: 0,
          pointsFor: 0, pointsAgainst: 0,
          triesFor: 0, triesAgainst: 0,
          bonusOffensive: 0, bonusDefensive: 0,
          bonusPoints: 0,
          points: 0,
        });
      }
      return standings.get(id);
    };

    for (const event of uniqueEvents) {
      const comp = (event.competitions || [])[0];
      if (!comp) continue;
      if (comp.status?.type?.name !== 'STATUS_FINAL') continue;

      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home?.team?.id || !away?.team?.id) continue;

      const scoreHome = parseInt(home.score) || 0;
      const scoreAway = parseInt(away.score) || 0;

      // Count tries from event details
      const details = comp.details || [];
      const homeTries = details.filter(d => d.type?.text === 'try' && d.team?.id === home.team.id).length;
      const awayTries = details.filter(d => d.type?.text === 'try' && d.team?.id === away.team.id).length;

      const homeRow = getOrCreate(home.team);
      const awayRow = getOrCreate(away.team);

      homeRow.played++;
      awayRow.played++;
      homeRow.pointsFor += scoreHome;
      homeRow.pointsAgainst += scoreAway;
      awayRow.pointsFor += scoreAway;
      awayRow.pointsAgainst += scoreHome;
      homeRow.triesFor += homeTries;
      homeRow.triesAgainst += awayTries;
      awayRow.triesFor += awayTries;
      awayRow.triesAgainst += homeTries;

      if (scoreHome > scoreAway) {
        homeRow.won++;   homeRow.points += 4;
        awayRow.lost++;
        if (homeTries - awayTries >= 3) { homeRow.bonusOffensive++; homeRow.bonusPoints++; homeRow.points++; }
        if (scoreHome - scoreAway <= 5)  { awayRow.bonusDefensive++; awayRow.bonusPoints++;  awayRow.points++; }
      } else if (scoreAway > scoreHome) {
        awayRow.won++;   awayRow.points += 4;
        homeRow.lost++;
        if (awayTries - homeTries >= 3) { awayRow.bonusOffensive++; awayRow.bonusPoints++; awayRow.points++; }
        if (scoreAway - scoreHome <= 5)  { homeRow.bonusDefensive++; homeRow.bonusPoints++;  homeRow.points++; }
      } else {
        homeRow.drawn++; homeRow.points += 2;
        awayRow.drawn++; awayRow.points += 2;
      }
    }

    if (standings.size === 0) return null;

    const sorted = Array.from(standings.values()).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const diffA = a.pointsFor - a.pointsAgainst;
      const diffB = b.pointsFor - b.pointsAgainst;
      if (diffB !== diffA) return diffB - diffA;
      return b.pointsFor - a.pointsFor;
    });

    return sorted.map((t, i) => ({
      ...t,
      rank: i + 1,
      diff: t.pointsFor - t.pointsAgainst,
    }));
  }

  // ─── Internal helpers ─────────────────────────────────────────────────

  async _fetchScoreboard(leagueId, dateRange = null) {
    const url = dateRange
      ? `${ESPN_BASE}/${leagueId}/scoreboard?dates=${dateRange}`
      : `${ESPN_BASE}/${leagueId}/scoreboard`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.events || [];
  }

  _normalizeEvent(event, compKey) {
    const competition = (event.competitions || [])[0];
    if (!competition) return null;

    const competitors = competition.competitors || [];
    if (competitors.length < 2) return null;

    // ESPN puts home team first in array (homeAway = "home")
    const home = competitors.find(c => c.homeAway === 'home') || competitors[0];
    const away = competitors.find(c => c.homeAway === 'away') || competitors[1];

    const statusName = competition.status?.type?.name || 'STATUS_SCHEDULED';
    const statusState = competition.status?.type?.state || 'pre';
    const statusCompleted = competition.status?.type?.completed ?? false;

    // Use explicit map first; fall back to state/completed for unknown ESPN status names
    const status = STATUS_MAP[statusName]
      ?? (statusCompleted ? 'FT' : statusState === 'in' ? '1H' : 'NS');

    const scoreHome = parseInt(home.score) || 0;
    const scoreAway = parseInt(away.score) || 0;

    // Skip phantom/TBD matches with no real teams
    if (!home.team?.id || !away.team?.id) return null;

    const dateStr = event.date || '';
    const matchDate = dateStr ? dateStr.split('T')[0] : '';
    const matchTime = dateStr && dateStr.includes('T')
      ? dateStr.split('T')[1].substring(0, 8)
      : '00:00:00';

    // Build a live clock string, e.g. "23'", "HT", "2T·5'"
    let match_clock = '';
    if (statusState === 'in') {
      const period = competition.status?.period || 1;
      const shortDetail = competition.status?.type?.shortDetail || '';
      if (statusName === 'STATUS_HALFTIME') {
        match_clock = 'HT';
      } else if (period >= 2) {
        match_clock = `2T·${shortDetail}`;   // e.g. "2T·5'"
      } else {
        match_clock = shortDetail;           // e.g. "23'"
      }
    }

    return {
      id: `espn-${event.id}`,
      competition: compKey,
      home_team_id: `espn-${home.team.id}`,
      away_team_id: `espn-${away.team.id}`,
      home_team_name: home.team.displayName || home.team.name,
      away_team_name: away.team.displayName || away.team.name,
      home_team_badge: home.team.logos?.[0]?.href || home.team.logo || '',
      away_team_badge: away.team.logos?.[0]?.href || away.team.logo || '',
      score_home: scoreHome,
      score_away: scoreAway,
      status,
      // ESPN scoreboard has no round numbers — use 0 (round-agnostic)
      round: 0,
      match_date: matchDate,
      match_time: matchTime,
      venue: competition.venue?.fullName || '',
      home_1h: 0,
      away_1h: 0,
      home_2h: 0,
      away_2h: 0,
      home_tries: 0,
      away_tries: 0,
      match_clock,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Extract scoring and disciplinary events from ESPN competition.details.
   * Returns an array suitable for insertScoreEvent().
   */
  _extractScoringEvents(competition, matchId) {
    const details = competition.details || [];
    const events = [];

    for (const d of details) {
      const typeText = d.type?.text?.toLowerCase() || '';
      if (!SCORING_TYPES.has(typeText)) continue;

      const teamId = d.team?.id ? `espn-${d.team.id}` : null;
      if (!teamId) continue;

      const clockSec = d.clock?.value || 0;
      const minute = Math.round(clockSec / 60);
      const half = minute < 42 ? 1 : 2;   // rough 1st/2nd half split
      const player = d.athletesInvolved?.[0]?.shortName || '';
      const eventType = ESPN_EVENT_TYPE_MAP[typeText] || typeText;

      events.push({
        match_id: matchId,
        team_id:  teamId,
        player,
        event_type: eventType,
        minute,
        half,
        detail: typeText,
      });
    }

    // Sort chronologically
    events.sort((a, b) => a.minute - b.minute);
    return events;
  }
}
