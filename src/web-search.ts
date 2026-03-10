/**
 * Web search for the local router pre-retrieval step.
 *
 * Priority:
 *   1. Brave Search API  (if BRAVE_SEARCH_API_KEY is set — best quality)
 *   2. DuckDuckGo HTML scrape  (free fallback, no key needed)
 *
 * Returns a short text block of search results to append to the Claude prompt.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envCfg = readEnvFile(['BRAVE_SEARCH_API_KEY']);
const BRAVE_KEY =
  process.env.BRAVE_SEARCH_API_KEY || envCfg.BRAVE_SEARCH_API_KEY || '';

const MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Brave Search API
// ---------------------------------------------------------------------------

async function braveSearch(query: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_KEY,
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: { title: string; url: string; description?: string }[] };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? '',
  }));
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML scrape
// ---------------------------------------------------------------------------

async function duckduckgoSearch(query: string): Promise<SearchResult[]> {
  // Use DDG lite HTML — no JS required, parses cleanly
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];

  // Extract result blocks: each result has a title link and a snippet
  const resultBlockRegex =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = resultBlockRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
    const url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  // Fallback: simpler extraction if regex above yields nothing
  if (results.length === 0) {
    const titleRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = titleRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
      const url = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (url && title && url.startsWith('http')) {
        results.push({ title, url, snippet: '' });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the web and return a formatted context block for inclusion in a prompt.
 */
export async function searchWeb(query: string): Promise<string> {
  logger.info({ query, engine: BRAVE_KEY ? 'brave' : 'duckduckgo' }, 'Web search');

  let results: SearchResult[] = [];

  try {
    results = BRAVE_KEY
      ? await braveSearch(query)
      : await duckduckgoSearch(query);
  } catch (err) {
    logger.warn({ err, query }, 'Web search failed');
    return '';
  }

  if (results.length === 0) {
    logger.warn({ query }, 'Web search returned no results');
    return '';
  }

  const lines = [
    `[Web search results for: "${query}"]`,
    '',
    ...results.map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
    ),
    '',
  ];

  return lines.join('\n');
}
