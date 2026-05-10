import { Router } from 'express';
import { getAllMatches, getMatch, getScoreEvents, getCompetitionRounds, getCompetitionDates, getRecommendedRound, getRecommendedDate, getStandings, getTeamRecentMatches } from '../db/database.js';

/**
 * Creates the matches/standings router, optionally injected with a data provider.
 * @param {object} provider - Instance of HybridProvider (or compatible)
 */
export default function createMatchesRouter(provider) {
  const router = Router();

  /**
   * GET /api/matches
   * Returns matches for a competition, optionally filtered by round or date.
   *
   * Query params:
   *   competition  – competition key (default: 'top14')
   *   round        – round number (Top14 only; 0 is ignored)
   *   date         – YYYY-MM-DD (ESPN competitions)
   *
   * Response includes:
   *   matches        – filtered match list
   *   availableRounds / currentRound  – for round-based navigation (Top14)
   *   availableDates / currentDate    – for date-based navigation (ESPN)
   */
  router.get('/matches', (req, res) => {
    try {
      const competition = req.query.competition || 'top14';
      let round = req.query.round ? parseInt(req.query.round) : null;
      const date = req.query.date || null;

      // ESPN sentinel — treat round=0 as "no round filter"
      if (round === 0) round = null;

      const availableRounds = getCompetitionRounds(competition);
      const availableDates  = getCompetitionDates(competition);
      const recommendedRound = getRecommendedRound(competition);
      const recommendedDate  = getRecommendedDate(competition);

      const matches = getAllMatches(competition, round, date);

      res.json({
        matches,
        currentRound:   round || recommendedRound,
        availableRounds,
        currentDate:    date || recommendedDate,
        availableDates,
      });
    } catch (err) {
      console.error('[Routes] Erreur GET /matches:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * GET /api/matches/:id
   * Retourne le détail d'un match + ses événements de score.
   */
  router.get('/matches/:id', (req, res) => {
    try {
      const match = getMatch(req.params.id);
      if (!match) {
        return res.status(404).json({ error: 'Match non trouvé' });
      }
      const events = getScoreEvents(req.params.id);
      res.json({ match, events });
    } catch (err) {
      console.error('[Routes] Erreur GET /matches/:id:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * GET /api/standings
   * Retourne le classement officiel d'une compétition via ESPN.
   * Falls back to DB-calculated standings if provider fetch fails.
   */
  router.get('/standings', async (req, res) => {
    try {
      const competition = req.query.competition || 'top14';

      // Try provider (ESPN) first
      let standings = null;
      if (provider?.fetchStandings) {
        standings = await provider.fetchStandings(competition);
      }

      // Fallback: compute from DB (Top14 only, or when ESPN fails)
      if (!standings || standings.length === 0) {
        console.warn(`[Routes] ESPN standings unavailable for ${competition}, falling back to DB`);
        standings = getStandings(competition);
      }

      res.json({ standings: standings || [] });
    } catch (err) {
      console.error('[Routes] Erreur GET /standings:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  /**
   * GET /api/team-form
   * Returns the last 5 finished matches for a team in a competition.
   *
   * Query params:
   *   teamId      – team id (e.g. espn-123 or lnr-456)
   *   competition – competition key
   *   limit       – optional, defaults to 5
   */
  router.get('/team-form', (req, res) => {
    try {
      const { teamId, competition } = req.query;
      if (!teamId || !competition) {
        return res.status(400).json({ error: 'teamId and competition are required' });
      }
      const limit = req.query.limit ? parseInt(req.query.limit) : 5;
      const matches = getTeamRecentMatches(teamId, competition, limit);
      res.json({ matches });
    } catch (err) {
      console.error('[Routes] Erreur GET /team-form:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
}
