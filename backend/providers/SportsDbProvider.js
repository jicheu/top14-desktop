import axios from 'axios';
import { DataProvider } from './DataProvider.js';

const BASE_URL = 'https://www.thesportsdb.com/api/v1/json';

// Top14 is handled by LnrProvider — do NOT include it here
const LEAGUE_MAP = {
  'prod2':                 { id: '4485', name: 'French Pro D2' },
  'premiership':           { id: '4414', name: 'English Prem Rugby' },
  'urc':                   { id: '4446', name: 'United Rugby Championship' },
  'super_rugby':           { id: '4415', name: 'Super Rugby Pacific' },
  'mlr':                   { id: '4625', name: 'Major League Rugby' },
  'english_championship':  { id: '4423', name: 'English Championship' },
  'six_nations_male':      { id: '4433', name: 'Six Nations' },
  'rugby_championship':    { id: '4434', name: 'Rugby Championship' },
  'champions_cup':         { id: '4480', name: 'European Rugby Champions Cup' },
  'challenge_cup':         { id: '4481', name: 'European Rugby Challenge Cup' },
};

export class SportsDbProvider extends DataProvider {
  constructor(apiKey = '3') {
    super();
    this.apiKey = apiKey;
    this.baseUrl = `${BASE_URL}/${this.apiKey}`;
    this.previousScores = new Map(); // matchId -> "home-away"
  }

  async fetchTeams() {
    // Teams are populated as a side-effect of fetchMatches
    return [];
  }

  async fetchMatches() {
    let allMatches = [];
    let allChanges = [];

    for (const [compKey, league] of Object.entries(LEAGUE_MAP)) {
      try {
        // Fetch upcoming + past events for this league
        const [nextResp, pastResp] = await Promise.all([
          axios.get(`${this.baseUrl}/eventsnextleague.php`, { params: { id: league.id } }),
          axios.get(`${this.baseUrl}/eventspastleague.php`, { params: { id: league.id } }),
        ]);

        const nextEvents = nextResp.data?.events || [];
        const pastEvents = pastResp.data?.results || [];

        // Deduplicate by id — past takes priority (has correct scores/status)
        const eventMap = new Map();
        nextEvents.forEach(e => eventMap.set(e.idEvent, e));
        pastEvents.forEach(e => eventMap.set(e.idEvent, e)); // overwrite with past (more accurate)

        const matches = Array.from(eventMap.values())
          .map(e => this._normalizeMatch(e, compKey))
          .filter(m => m !== null);

        console.log(`[SportsDB] ${compKey}: ${pastEvents.length} past + ${nextEvents.length} next = ${matches.length} unique`);

        // Detect score changes
        for (const match of matches) {
          const key = match.id;
          const scoreStr = `${match.score_home}-${match.score_away}`;
          if (this.previousScores.has(key) && this.previousScores.get(key) !== scoreStr) {
            allChanges.push({ type: 'score', match });
          }
          this.previousScores.set(key, scoreStr);
        }

        allMatches = allMatches.concat(matches);
      } catch (err) {
        if (err.response?.status === 429) {
          console.warn(`[SportsDB] Rate limited on ${compKey}, skipping`);
        } else {
          console.error(`[SportsDB] Error fetching ${compKey}:`, err.message);
        }
      }
    }

    return { matches: allMatches, changes: allChanges };
  }

  async fetchScoreEvents(matchId) {
    try {
      const resp = await axios.get(`${this.baseUrl}/lookuptimeline.php`, { params: { id: matchId } });
      if (!resp.data?.timeline) return [];
      return resp.data.timeline.map(t => ({
        match_id: matchId,
        team_id: t.idTeam,
        player: t.strPlayer || 'Inconnu',
        event_type: this._normalizeEventType(t.strTimeline),
        minute: parseInt(t.intTime) || 0,
        half: (parseInt(t.intTime) || 0) <= 40 ? 1 : 2,
        detail: t.strTimelineDetail || '',
      }));
    } catch (err) {
      console.error('[SportsDB] Error fetching events:', err.message);
      return [];
    }
  }

  /**
   * Map a SportsDB event to our internal match format.
   * Key fix: infer status from date + scores rather than trusting strStatus.
   */
  _normalizeMatch(event, competition) {
    // Skip events with missing critical data
    if (!event.idEvent || !event.idHomeTeam || !event.idAwayTeam || !event.dateEvent) {
      return null;
    }

    const scoreHome = parseInt(event.intHomeScore);
    const scoreAway = parseInt(event.intAwayScore);
    const hasScores = !isNaN(scoreHome) && !isNaN(scoreAway);

    // Infer correct status — SportsDB often mislabels historical matches as "Not Started"
    const status = this._inferStatus(event.dateEvent, event.strStatus, hasScores, scoreHome, scoreAway);

    return {
      id: event.idEvent,
      competition,
      home_team_id: event.idHomeTeam,
      away_team_id: event.idAwayTeam,
      score_home: hasScores ? scoreHome : 0,
      score_away: hasScores ? scoreAway : 0,
      status,
      round: parseInt(event.intRound) || 0,
      match_date: event.dateEvent,
      match_time: event.strTime || '00:00:00',
      venue: event.strVenue || '',
      home_1h: 0,
      away_1h: 0,
      home_2h: 0,
      away_2h: 0,
      home_tries: 0,
      away_tries: 0,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Infer the real match status.
   *
   * SportsDB problems on the free tier:
   *  - Past matches returned as "Not Started" even with final scores
   *  - Live status rarely propagates on free tier
   *  - "Match Finished" is correct when present
   */
  _inferStatus(dateStr, rawStatus, hasScores, scoreHome, scoreAway) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const matchDate = new Date(dateStr);
    matchDate.setHours(0, 0, 0, 0);

    const isPast   = matchDate < today;
    const isToday  = matchDate.getTime() === today.getTime();
    const isFuture = matchDate > today;

    // Trust explicit "Match Finished" from SportsDB
    if (rawStatus === 'Match Finished') return 'FT';

    // Past date: if there are scores it finished, if no scores still mark FT
    // (rugby matches always have a score when finished, 0-0 would be bizarre but treat as FT)
    if (isPast) {
      if (hasScores) return 'FT';
      // Past match with no scores — data might be missing, still mark FT
      return 'FT';
    }

    // Today: if scores present it's at least started
    if (isToday) {
      if (rawStatus === 'Not Started' && !hasScores) return 'NS';
      if (hasScores) {
        // SportsDB doesn't give granular live status on free tier
        // — we can't tell 1H/HT/2H, mark as live placeholder
        return '1H';
      }
      return 'NS';
    }

    // Future match
    if (isFuture) return 'NS';

    return 'NS';
  }

  _normalizeEventType(type) {
    const map = {
      'try':          'essai',
      'goal':         'essai',
      'conversion':   'transformation',
      'penalty':      'penalite',
      'penalty goal': 'penalite',
      'drop goal':    'drop',
      'drop_goal':    'drop',
      'yellow card':  'carton_jaune',
      'red card':     'carton_rouge',
    };
    return map[(type || '').toLowerCase()] || type;
  }
}
