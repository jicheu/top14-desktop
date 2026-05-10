import { DataProvider } from './DataProvider.js';
import { LnrProvider } from './LnrProvider.js';
import { EspnProvider } from './EspnProvider.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';
const TOP14_ESPN_ID = '270559';

/**
 * HybridProvider
 *  - LnrProvider  → Top 14 (official LNR website, accurate live scores)
 *  - EspnProvider → All other competitions (ESPN API, accurate statuses + standings)
 *
 * Top14 historical rounds are supplemented by ESPN date-range data.
 * ESPN events are grouped into round clusters and assigned round numbers
 * relative to the LNR current round.
 */
export class HybridProvider extends DataProvider {
  constructor() {
    super();
    this.lnrProvider  = new LnrProvider();
    this.espnProvider = new EspnProvider();
    console.log('[HybridProvider] LNR (Top14) + ESPN (other competitions)');
  }

  async fetchTeams() {
    const [lnrTeams] = await Promise.all([
      this.lnrProvider.fetchTeams().catch(() => []),
      // ESPN teams are embedded in match data — no separate fetch needed
    ]);
    return lnrTeams;
  }

  async fetchMatches() {
    const [lnrResult, espnResult] = await Promise.all([
      this.lnrProvider.fetchMatches().catch(err => {
        console.error('[HybridProvider] LNR error:', err.message);
        return { matches: [], changes: [] };
      }),
      this.espnProvider.fetchMatches().catch(err => {
        console.error('[HybridProvider] ESPN error:', err.message);
        return { matches: [], changes: [] };
      }),
    ]);

    const lnrMatches  = (lnrResult.matches  || []).filter(m => m?.id && m?.home_team_id && m?.away_team_id);
    const espnMatches = (espnResult.matches || []).filter(m => m?.id && m?.home_team_id && m?.away_team_id);

    // Fetch ESPN Top14 historical rounds to supplement LNR's single-round data
    const top14History = await this._fetchTop14History(lnrMatches).catch(err => {
      console.error('[HybridProvider] Top14 history error:', err.message);
      return [];
    });

    const all = [...lnrMatches, ...top14History, ...espnMatches];
    const changes = [...(lnrResult.changes || []), ...(espnResult.changes || [])];

    console.log(`[HybridProvider] ${lnrMatches.length} Top14 LNR + ${top14History.length} Top14 hist + ${espnMatches.length} other ESPN`);
    return { matches: all, changes };
  }

  /**
   * Fetch ESPN Top14 events for the past 10 weeks and assign round numbers
   * by clustering events by date and mapping relative to the LNR current round.
   * Skips dates already covered by LNR matches to avoid duplicates.
   */
  async _fetchTop14History(lnrMatches) {
    const fmt = d => d.toISOString().split('T')[0].replace(/-/g, '');
    const now = new Date();
    const start = new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000); // 10 weeks back
    const end   = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 2 weeks ahead
    const dateRange = `${fmt(start)}-${fmt(end)}`;

    const resp = await fetch(`${ESPN_BASE}/${TOP14_ESPN_ID}/scoreboard?dates=${dateRange}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const events = data.events || [];

    if (events.length === 0) return [];

    // Dates already covered by LNR (skip them to avoid duplicate matches for current round)
    const lnrDates = new Set(lnrMatches.map(m => m.match_date).filter(Boolean));

    // Determine current LNR round number and a representative date
    const currentRound = lnrMatches.length > 0 ? lnrMatches[0].round : null;
    const currentRoundDates = new Set(lnrMatches.map(m => m.match_date));

    // Group ESPN events into date clusters (dates within 4 days = same round)
    const dateClusters = this._clusterByDate(events, 4);

    // Sort clusters chronologically
    dateClusters.sort((a, b) => a.minDate.localeCompare(b.minDate));

    // Find which cluster corresponds to the current LNR round
    let currentClusterIdx = -1;
    if (currentRound && currentRoundDates.size > 0) {
      const lnrMinDate = [...currentRoundDates].sort()[0];
      // Find the cluster whose date range overlaps or is closest to the LNR round dates
      // NOTE: cluster.dates is a Set — must spread to use .some()
      currentClusterIdx = dateClusters.findIndex(c =>
        [...c.dates].some(d => currentRoundDates.has(d))
      );
      if (currentClusterIdx === -1) {
        // Fallback: find cluster closest to LNR round dates
        currentClusterIdx = dateClusters.reduce((best, c, i) => {
          const dist = Math.abs(new Date(c.minDate) - new Date(lnrMinDate));
          const bestDist = best === -1 ? Infinity : Math.abs(new Date(dateClusters[best].minDate) - new Date(lnrMinDate));
          return dist < bestDist ? i : best;
        }, -1);
      }
    }

    // Assign round numbers to each cluster
    const matches = [];
    for (let i = 0; i < dateClusters.length; i++) {
      const cluster = dateClusters[i];

      // Compute round number relative to the current LNR round
      const roundOffset = i - (currentClusterIdx === -1 ? dateClusters.length - 1 : currentClusterIdx);
      const roundNumber = currentRound ? currentRound + roundOffset : 0;

      // Skip the current round (LNR already covers it)
      if (roundOffset === 0 && currentRound) continue;

      // Skip dates already in LNR (cluster.dates is a Set — spread to use .some())
      const clusterHasLnrDates = [...cluster.dates].some(d => lnrDates.has(d));
      if (clusterHasLnrDates) continue;

      for (const event of cluster.events) {
        const match = this.espnProvider._normalizeEvent(event, 'top14');
        if (!match) continue;
        match.round = roundNumber > 0 ? roundNumber : 0;
        matches.push(match);
      }
    }

    console.log(`[HybridProvider] Top14 ESPN history: ${matches.length} matches across ${dateClusters.length} clusters`);
    return matches;
  }

  /**
   * Group ESPN events into clusters where consecutive dates are within maxGapDays of each other.
   * Returns array of { minDate, maxDate, dates: Set, events: [] }
   */
  _clusterByDate(events, maxGapDays) {
    // Build a map of date → events
    const byDate = new Map();
    for (const event of events) {
      const date = (event.date || '').split('T')[0];
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(event);
    }

    const sortedDates = [...byDate.keys()].sort();
    if (sortedDates.length === 0) return [];

    const clusters = [];
    let current = { minDate: sortedDates[0], maxDate: sortedDates[0], dates: new Set([sortedDates[0]]), events: [...byDate.get(sortedDates[0])] };

    for (let i = 1; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const prev = sortedDates[i - 1];
      const gap = (new Date(date) - new Date(prev)) / (24 * 60 * 60 * 1000);

      if (gap <= maxGapDays) {
        current.maxDate = date;
        current.dates.add(date);
        current.events.push(...byDate.get(date));
      } else {
        clusters.push(current);
        current = { minDate: date, maxDate: date, dates: new Set([date]), events: [...byDate.get(date)] };
      }
    }
    clusters.push(current);
    return clusters;
  }

  async fetchScoreEvents(matchId) {
    if (matchId.startsWith('lnr-')) {
      return this.lnrProvider.fetchScoreEvents(matchId).catch(() => []);
    }
    return this.espnProvider.fetchScoreEvents(matchId).catch(() => []);
  }

  /** Proxy standings fetch to EspnProvider (handles both LNR and non-LNR competitions) */
  async fetchStandings(compKey) {
    return this.espnProvider.fetchStandings(compKey);
  }
}
