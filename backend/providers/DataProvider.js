/**
 * DataProvider - Interface de base pour les sources de données.
 * Toute implémentation (Mock, TheSportsDB, scraper...) doit respecter ce contrat.
 */
export class DataProvider {
  /**
   * Récupère la liste des matchs de la journée/round en cours.
   * @returns {Promise<Array>} Liste de matchs normalisés
   */
  async fetchMatches() {
    throw new Error('fetchMatches() doit être implémenté');
  }

  /**
   * Récupère les événements de score pour un match donné.
   * @param {string} matchId
   * @returns {Promise<Array>} Liste d'événements de score
   */
  async fetchScoreEvents(matchId) {
    throw new Error('fetchScoreEvents() doit être implémenté');
  }

  /**
   * Récupère la liste des équipes.
   * @returns {Promise<Array>} Liste d'équipes normalisées
   */
  async fetchTeams() {
    throw new Error('fetchTeams() doit être implémenté');
  }
}
