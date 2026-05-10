import axios from 'axios';
import { DataProvider } from './DataProvider.js';

const LNR_BASE = 'https://top14.lnr.fr';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Map LNR slugSubType -> our internal event_type
const EVENT_TYPE_MAP = {
  essai: 'essai',
  penalite: 'penalite',
  transformation: 'transformation',
  drop: 'drop',
  jaune: 'carton_jaune',
  rouge: 'carton_rouge',
};

// Points par type d'événement
const POINTS = { essai: 5, transformation: 2, penalite: 3, drop: 3 };

/**
 * LnrProvider - Scrape le site officiel top14.lnr.fr pour obtenir
 * les matchs et les événements de score en temps réel.
 *
 * Homepage -> score-slider :matches prop -> liste des matchs
 * Detail page -> header-timeline :game-facts prop -> événements de score
 *              + match-score :match prop -> halftimeScore
 */
export class LnrProvider extends DataProvider {
  constructor() {
    super();
    this.previousMatches = new Map(); // id -> match data for change detection
    this.previousEvents = new Map();  // matchId -> Set of event ids
    this.teams = new Map();           // id -> team data (cached)
  }

  /**
   * Fetch HTML from LNR with retry.
   */
  async _fetch(url) {
    try {
      const resp = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
      });
      return resp.data;
    } catch (err) {
      console.error(`[LnrProvider] Erreur fetch ${url}:`, err.message);
      return null;
    }
  }

  /**
   * Extract JSON from a Vue prop attribute in HTML.
   * Looks for :propName='...' and parses the JSON content.
   * Since LNR uses single-quoted Vue attributes and the JSON inside uses
   * double quotes, we can safely match everything between the single quotes.
   */
  _extractProp(html, propName) {
    // Match :propName='...' — capture everything between the single quotes
    const regex = new RegExp(`:${propName}='([^']*)'`);
    const match = html.match(regex);
    if (!match) return null;

    try {
      // LNR uses HTML entities in some places, decode them
      const jsonStr = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'");
      return JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[LnrProvider] Erreur parsing prop ${propName}:`, err.message);
      return null;
    }
  }

  /**
   * Map LNR status + timer to our internal status (NS, 1H, HT, 2H, FT).
   */
  _mapStatus(lnrMatch) {
    if (lnrMatch.is_postponed) return 'PST';

    switch (lnrMatch.status) {
      case 'finished':
        return 'FT';
      case 'not-started':
        return 'NS';
      case 'live': {
        const timer = lnrMatch.timer || {};
        // If secondPeriodStartDate is set (not null), we're in 2H
        if (timer.secondPeriodStartDate) return '2H';
        // If firstPeriodEndDate is set (not null), first half ended -> HT
        if (timer.firstPeriodEndDate) return 'HT';
        // Otherwise, still in 1H
        return '1H';
      }
      default:
        return 'NS';
    }
  }

  /**
   * Parse time string like "14h30" or "21h00" into "14:30:00"
   */
  _parseTime(timeStr) {
    if (!timeStr) return null;
    const m = timeStr.match(/(\d+)h(\d+)/);
    if (!m) return timeStr;
    return `${m[1].padStart(2, '0')}:${m[2]}:00`;
  }

  /**
   * Parse date string like "09/05" into "2025-05-09" (assumes current year context)
   */
  _parseDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('/');
    if (parts.length !== 2) return dateStr;
    const now = new Date();
    // LNR season spans two years; use year from context
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[0], 10);
    // Season 2025-2026: months Aug-Dec = 2025, Jan-Jul = 2026
    const year = month >= 8 ? now.getFullYear() - (now.getMonth() < 7 ? 1 : 0) : now.getFullYear();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /**
   * Build a unique team ID from LNR club data.
   */
  _teamId(club) {
    return `lnr-${club.id}`;
  }

  /**
   * Register a team from LNR club data and return its internal id.
   */
  _registerTeam(club) {
    const id = this._teamId(club);
    if (!this.teams.has(id)) {
      this.teams.set(id, {
        id,
        name: club.name,
        badge_url: club.logo?.['thumbnail-2x'] || club.logo?.original || '',
      });
    }
    return id;
  }

  /**
   * Normalize a single LNR match into our internal format.
   */
  _normalizeMatch(lnrMatch, currentWeek) {
    const homeTeamId = this._registerTeam(lnrMatch.hosting_club);
    const awayTeamId = this._registerTeam(lnrMatch.visiting_club);
    const status = this._mapStatus(lnrMatch);
    const [scoreHome, scoreAway] = lnrMatch.score || [0, 0];

    return {
      id: `lnr-${lnrMatch.id}`,
      lnr_id: lnrMatch.id,
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      score_home: scoreHome,
      score_away: scoreAway,
      status,
      round: currentWeek?.number || null,
      match_date: this._parseDate(lnrMatch.date),
      match_time: this._parseTime(lnrMatch.time),
      venue: null, // not provided in homepage data
      home_1h: 0,
      away_1h: 0,
      home_2h: 0,
      away_2h: 0,
      home_tries: 0,
      away_tries: 0,
      competition: 'top14',
      updated_at: new Date().toISOString(),
      // Keep the detail link for fetching score events
      _detail_link: lnrMatch.link,
    };
  }

  // ─── DataProvider interface ───────────────────────────────────────────

  async fetchTeams() {
    // Teams are populated as a side-effect of fetchMatches.
    // If we have no teams yet, do a lightweight homepage fetch to discover them.
    if (this.teams.size === 0) {
      const html = await this._fetch(LNR_BASE);
      if (html) {
        const lnrMatches = this._extractProp(html, 'matches');
        if (lnrMatches && Array.isArray(lnrMatches)) {
          for (const m of lnrMatches) {
            this._registerTeam(m.hosting_club);
            this._registerTeam(m.visiting_club);
          }
        }
      }
    }
    return Array.from(this.teams.values());
  }

  async fetchMatches() {
    const html = await this._fetch(LNR_BASE);
    if (!html) {
      console.warn('[LnrProvider] Impossible de charger la page d\'accueil, retour données en cache');
      return { matches: Array.from(this.previousMatches.values()), changes: [] };
    }

    // Extract matches JSON from score-slider :matches prop
    const lnrMatches = this._extractProp(html, 'matches');
    if (!lnrMatches || !Array.isArray(lnrMatches)) {
      console.warn('[LnrProvider] Aucun match trouvé dans le HTML');
      return { matches: Array.from(this.previousMatches.values()), changes: [] };
    }

    // Extract current week
    const currentWeek = this._extractProp(html, 'current-week');

    // Normalize matches
    const matches = lnrMatches.map(m => this._normalizeMatch(m, currentWeek));

    // Snapshot previous event IDs before fetching details (which overwrites cache)
    const prevEventIds = new Map();
    for (const [matchId, data] of this.previousEvents) {
      prevEventIds.set(matchId, new Set(data.eventIds));
    }

    // For live and finished matches, fetch detail pages for halftime scores and events
    const detailPromises = [];
    for (const match of matches) {
      const isLiveOrFinished = ['1H', 'HT', '2H', 'FT'].includes(match.status);
      if (isLiveOrFinished && match._detail_link) {
        detailPromises.push(
          this._fetchMatchDetail(match).catch(err => {
            console.error(`[LnrProvider] Erreur détail match ${match.id}:`, err.message);
          })
        );
      }
    }

    // Fetch all detail pages in parallel (max concurrency = number of matches, ~7)
    await Promise.all(detailPromises);

    // Detect changes (using snapshotted previous event IDs)
    const changes = this._detectChanges(matches, prevEventIds);

    // Update cache
    for (const match of matches) {
      // Remove internal fields before storing
      const { _detail_link, ...cleanMatch } = match;
      this.previousMatches.set(match.id, cleanMatch);
    }

    // Return clean matches (without _detail_link)
    const cleanMatches = matches.map(({ _detail_link, ...rest }) => rest);
    return { matches: cleanMatches, changes };
  }

  /**
   * Fetch match detail page and update halftime scores + cache score events.
   */
  async _fetchMatchDetail(match) {
    const html = await this._fetch(match._detail_link);
    if (!html) return;

    // Extract halftimeScore from match-score :match prop
    const matchScoreData = this._extractProp(html, 'match');
    if (matchScoreData?.halftimeScore) {
      const [h1h, a1h] = matchScoreData.halftimeScore;
      match.home_1h = h1h;
      match.away_1h = a1h;
      // Calculate 2H scores from totals
      if (match.status === 'FT' || match.status === '2H') {
        match.home_2h = match.score_home - h1h;
        match.away_2h = match.score_away - a1h;
      }
    }

    // Extract game-facts from header-timeline :game-facts prop
    const gameFacts = this._extractProp(html, 'game-facts');
    if (gameFacts && Array.isArray(gameFacts)) {
      // Cache events for this match, to be served by fetchScoreEvents
      this._cacheEvents(match, gameFacts);
    }
  }

  /**
   * Cache normalized score events for a match.
   */
  _cacheEvents(match, gameFacts) {
    const events = [];
    const eventIds = new Set();
    let homeTries = 0;
    let awayTries = 0;

    for (const fact of gameFacts) {
      const eventType = EVENT_TYPE_MAP[fact.slugSubType];
      if (!eventType) continue; // Skip unknown event types

      const isHome = fact.club === 'home';
      const teamId = isHome ? match.home_team_id : match.away_team_id;
      const playerName = fact.player
        ? `${fact.player.firstName} ${fact.player.lastName}`
        : 'Inconnu';

      const points = POINTS[eventType] || 0;
      const detail = points > 0
        ? `${playerName} - ${fact.subtype} (${points} pts)`
        : `${playerName} - ${fact.subtype}`;

      // Count tries
      if (eventType === 'essai') {
        if (isHome) homeTries++;
        else awayTries++;
      }

      events.push({
        id: fact.id,
        match_id: match.id,
        team_id: teamId,
        player: playerName,
        event_type: eventType,
        minute: fact.minute,
        half: fact.period,
        detail,
        // Extra data for richer display
        score_after: fact.score, // [home, away] running score
        conversion_player: fact.conversionPlayer
          ? `${fact.conversionPlayer.firstName} ${fact.conversionPlayer.lastName}`
          : null,
      });

      eventIds.add(fact.id);
    }

    // Update match with try counts
    match.home_tries = homeTries;
    match.away_tries = awayTries;

    // Store the event ids set for change detection
    this.previousEvents.set(match.id, { events, eventIds });
  }

  /**
   * Detect changes between current and previous match states.
   * Returns an array of change objects compatible with the Poller.
   */
  _detectChanges(currentMatches, prevEventIds) {
    const changes = [];

    for (const match of currentMatches) {
      const prev = this.previousMatches.get(match.id);

      if (!prev) {
        // New match appeared
        changes.push({ type: 'new', match });
        // Fall through to check for events (don't continue)
      } else {
        // Score changed
        if (prev.score_home !== match.score_home || prev.score_away !== match.score_away) {
          changes.push({ type: 'score', match });
        }

        // Status changed
        if (prev.status !== match.status) {
          changes.push({ type: 'status', match });
        }
      }

      // Check for new score events -> if any new, emit ALL events for this match
      const oldIds = prevEventIds.get(match.id) || new Set();
      const currEventData = this.previousEvents.get(match.id);
      if (currEventData) {
        const hasNewEvents = currEventData.events.some(e => !oldIds.has(e.id));
        if (hasNewEvents) {
          // Send all events for this match so the poller can clear+reinsert
          changes.push({ type: 'events_full', match, events: currEventData.events });
        }
      }
    }

    return changes;
  }

  async fetchScoreEvents(matchId) {
    // If we have cached events, return them
    const cached = this.previousEvents.get(matchId);
    if (cached) return cached.events;

    // Otherwise try to fetch the detail page
    const match = this.previousMatches.get(matchId);
    if (!match) return [];

    // We need the detail link, but it's been stripped. Reconstruct from LNR pattern.
    // Try fetching from homepage to get the link
    const html = await this._fetch(LNR_BASE);
    if (!html) return [];

    const lnrMatches = this._extractProp(html, 'matches');
    if (!lnrMatches) return [];

    const lnrId = matchId.replace('lnr-', '');
    const lnrMatch = lnrMatches.find(m => String(m.id) === lnrId);
    if (!lnrMatch?.link) return [];

    const detailHtml = await this._fetch(lnrMatch.link);
    if (!detailHtml) return [];

    const gameFacts = this._extractProp(detailHtml, 'game-facts');
    if (!gameFacts || !Array.isArray(gameFacts)) return [];

    // Need a match-like object to cache events
    const matchObj = { ...match, id: matchId };
    this._cacheEvents(matchObj, gameFacts);

    return this.previousEvents.get(matchId)?.events || [];
  }
}
