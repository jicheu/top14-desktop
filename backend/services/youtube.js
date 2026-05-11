/**
 * YouTube Data API v3 — match summary search.
 *
 * Requires YOUTUBE_API_KEY in the environment.
 * Each search.list call costs 100 quota units (free tier: 10,000/day).
 * Results are cached in the DB so each match is searched at most once.
 */

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/search';

/**
 * Map full club names → short city/common name used in video titles.
 * Keys are lowercased for case-insensitive matching.
 */
const TEAM_NAME_MAP = {
  // Top 14
  'asm clermont':               'Clermont',
  'clermont auvergne':          'Clermont',
  'aviron bayonnais':           'Bayonne',
  'bordeaux begles':            'Bordeaux',
  'union bordeaux-bègles':      'Bordeaux',
  'union bordeaux begles':      'Bordeaux',
  'castres olympique':          'Castres',
  'lou rugby':                  'Lyon',
  'la rochelle':                'La Rochelle',
  'stade rochelais':            'La Rochelle',
  'montpellier herault':        'Montpellier',
  'montpellier hérault':        'Montpellier',
  'montpellier hérault rugby':  'Montpellier',
  'montpellier herault rugby':  'Montpellier',
  'rc toulon':                  'Toulon',
  'section paloise':            'Pau',
  'stade francais paris':       'Stade Français',
  'stade français paris':       'Stade Français',
  'stade toulousain':           'Toulouse',
  'us montauban':               'Montauban',
  'usa perpignan':              'Perpignan',
  // Premiership
  'bath rugby':                 'Bath',
  'bristol rugby':              'Bristol',
  'exeter chiefs':              'Exeter',
  'gloucester rugby':           'Gloucester',
  'leicester tigers':           'Leicester',
  'newcastle falcons':          'Newcastle',
  'northampton saints':         'Northampton',
  'sale sharks':                'Sale',
};

/** Reduce a full club name to a short searchable city/brand name. */
function shortName(name) {
  const key = name.toLowerCase().trim();
  if (TEAM_NAME_MAP[key]) return TEAM_NAME_MAP[key];

  // Generic stripping: remove common prefixes/suffixes then take first word(s)
  let s = name
    .replace(/^(US|RC|ASM|LOU|UBB|SU|CA|FC|SC|AC)\s+/i, '')
    .replace(/\s+(Rugby|Olympique|Football|Club|Sport|Auvergne|Hérault|Herault|Tigers?|Chiefs?|Sharks?|Falcons?|Saints?|Warriors?|Blues?)$/i, '')
    .trim();

  // If "La Rochelle" style multi-word city, keep up to 2 words
  const words = s.split(/\s+/);
  return words.slice(0, 2).join(' ');
}

/**
 * Search YouTube for a highlight/summary video for a finished match.
 * Tries multiple query variants to maximise hit rate while minimising quota use.
 *
 * @param {object} match  - match row from DB (home_team_name, away_team_name, match_date, competition)
 * @returns {{ videoId: string, title: string } | null}
 */
export async function searchMatchSummary(match) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.warn('[YouTube] YOUTUBE_API_KEY not set — skipping search');
    return null;
  }

  const { home_team_name, away_team_name, match_date, competition } = match;

  const home = shortName(home_team_name);
  const away = shortName(away_team_name);
  const compLabel = competitionLabel(competition);

  // publishedAfter: one day before match date to be safe (videos sometimes
  // appear shortly before/after midnight)
  let publishedAfter;
  if (match_date) {
    const d = new Date(match_date);
    d.setDate(d.getDate() - 1);
    publishedAfter = d.toISOString().split('T')[0] + 'T00:00:00Z';
  }

  // Try multiple query variants in priority order; stop on first hit.
  // This covers the two common title styles used by Canal+, France TV, LNR, etc.:
  //   "Résumé | Toulouse - Clermont | Top 14"
  //   "Toulouse vs Clermont highlights Top 14"
  const queries = [
    `${home} ${away} résumé ${compLabel}`,
    `${away} ${home} résumé ${compLabel}`,
    `${home} ${away} highlights ${compLabel}`,
    `${away} ${home} highlights ${compLabel}`,
  ];

  for (const query of queries) {
    const params = new URLSearchParams({
      part:       'snippet',
      q:          query,
      type:       'video',
      order:      'relevance',
      maxResults: '5',
      key:        apiKey,
      ...(publishedAfter ? { publishedAfter } : {}),
    });

    console.log(`[YouTube] Searching: "${query}"${publishedAfter ? ` after ${publishedAfter}` : ''}`);

    try {
      const resp = await fetch(`${YOUTUBE_API}?${params}`);
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[YouTube] API error ${resp.status}: ${body}`);
        return null; // Hard error — don't retry other variants
      }

      const data = await resp.json();
      const items = data.items || [];

      if (items.length === 0) {
        console.log(`[YouTube] No results for: "${query}" — trying next variant`);
        continue;
      }

      const first = items[0];
      const videoId = first.id?.videoId;
      const title   = first.snippet?.title;

      if (!videoId) continue;

      console.log(`[YouTube] Found: "${title}" (${videoId})`);
      return { videoId, title };
    } catch (err) {
      console.error('[YouTube] Fetch error:', err.message);
      return null;
    }
  }

  console.log(`[YouTube] No results found for ${home} vs ${away} across all query variants`);
  return null;
}

function competitionLabel(competition) {
  const labels = {
    top14:          'Top 14',
    prod2:          'Pro D2',
    premiership:    'Premiership',
    urc:            'URC',
    super_rugby:    'Super Rugby',
    champions_cup:  'Champions Cup',
    challenge_cup:  'Challenge Cup',
  };
  return labels[competition] || 'rugby';
}
