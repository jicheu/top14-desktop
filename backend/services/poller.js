import { upsertTeam, upsertMatch, insertScoreEvent, clearScoreEvents, getAllMatches } from '../db/database.js';

const POLL_INTERVAL = 30_000; // 30 secondes

/**
 * Poller - Interroge le DataProvider à intervalles réguliers,
 * met à jour la base de données et notifie via callback en cas de changement.
 */
export class Poller {
  constructor(provider, onUpdate) {
    this.provider = provider;
    this.onUpdate = onUpdate; // callback(changes)
    this.interval = null;
    this.isFirstRun = true;
  }

  async start() {
    console.log('[Poller] Démarrage du polling...');

    // Charger les équipes au démarrage
    await this._loadTeams();

    // Premier fetch immédiat
    await this._poll();

    // Puis toutes les 30 secondes
    this.interval = setInterval(() => this._poll(), POLL_INTERVAL);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[Poller] Arrêt du polling.');
    }
  }

  setProvider(newProvider) {
    this.provider = newProvider;
    this.isFirstRun = true;
  }

  async _loadTeams() {
    try {
      const teams = await this.provider.fetchTeams();
      for (const team of teams) {
        upsertTeam(team);
      }
      console.log(`[Poller] ${teams.length} équipes chargées`);
    } catch (err) {
      console.error('[Poller] Erreur chargement équipes:', err.message);
    }
  }

  async _poll() {
    try {
      const { matches, changes } = await this.provider.fetchMatches();

      // Mettre à jour la base de données
      for (const match of matches) {
        // Upsert teams embedded in match data (ESPN matches carry team info inline)
        if (match.home_team_name) {
          upsertTeam({ id: match.home_team_id, name: match.home_team_name, badge_url: match.home_team_badge || '' });
        }
        if (match.away_team_name) {
          upsertTeam({ id: match.away_team_id, name: match.away_team_name, badge_url: match.away_team_badge || '' });
        }
        upsertMatch(match);
      }

      // Insérer les nouveaux événements de score
      for (const change of changes) {
        if (change.type === 'score' && change.event) {
          // Individual event (Mock provider)
          insertScoreEvent(change.event);
        } else if (change.type === 'events_full' && change.events) {
          // Full event list for a match (LNR provider) - clear + reinsert
          clearScoreEvents(change.events[0]?.match_id);
          for (const event of change.events) {
            insertScoreEvent(event);
          }
        }
      }

      // Notifier le serveur des changements
      if (changes.length > 0 || this.isFirstRun) {
        // Note: getAllMatches() is now competition-aware in DB, 
        // but here we might need all matches or filter.
        // For simplicity, we fetch all matches and broadcast.
        const allMatches = getAllMatches();
        this.onUpdate({
          matches: allMatches,
          changes,
          isInitial: this.isFirstRun,
        });
      }

      this.isFirstRun = false;
    } catch (err) {
      console.error('[Poller] Erreur polling:', err.message);
    }
  }
}
