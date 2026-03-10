/**
 * Web search for the local router pre-retrieval step.
 *
 * Uses SearXNG — free, open-source, privacy-respecting meta-search engine.
 * No API key required. Configure SEARXNG_URL to point to your own instance
 * (recommended) or leave unset to use a public instance.
 *
 * To run your own local instance:
 *   docker run -d -p 8080:8080 searxng/searxng
 *   Then add SEARXNG_URL=http://localhost:8080 to .env
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envCfg = readEnvFile(['SEARXNG_URL']);

// Public SearXNG instances — tried in order on failure
const PUBLIC_INSTANCES = [
  'https://searx.be',
  'https://searxng.world',
  'https://paulgo.io',
];

const SEARXNG_URL =
  process.env.SEARXNG_URL || envCfg.SEARXNG_URL || PUBLIC_INSTANCES[0];

const MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searxngSearch(
  query: string,
  baseUrl: string,
): Promise<SearchResult[]> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status} from ${baseUrl}`);
  const data = (await res.json()) as {
    results?: { title: string; url: string; content?: string }[];
  };
  return (data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? '',
  }));
}

/**
 * Search the web via SearXNG and return a formatted context block.
 * Falls back through public instances if the configured one fails.
 */
export async function searchWeb(query: string): Promise<string> {
  const isCustom = !!(envCfg.SEARXNG_URL || process.env.SEARXNG_URL);
  const instancesToTry = isCustom
    ? [SEARXNG_URL]
    : [SEARXNG_URL, ...PUBLIC_INSTANCES.filter((u) => u !== SEARXNG_URL)];

  logger.info({ query, instance: instancesToTry[0] }, 'Web search via SearXNG');

  let results: SearchResult[] = [];

  for (const instance of instancesToTry) {
    try {
      results = await searxngSearch(query, instance);
      if (results.length > 0) break;
    } catch (err) {
      logger.warn({ err, instance }, 'SearXNG instance failed, trying next');
    }
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
