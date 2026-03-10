/**
 * Local AI Router — uses Ollama to handle simple messages locally,
 * escalating to the Claude container only when needed.
 *
 * The local model returns one of three responses:
 *   - Direct answer  → handled locally, tagged "— local"
 *   - ESCALATE       → hand off to Claude immediately
 *   - CLARIFY: <q>   → ask the user a clarifying question first,
 *                       then send enriched context to Claude
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { ASSISTANT_NAME } from './config.js';

const envCfg = readEnvFile([
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'LOCAL_ROUTER_ENABLED',
]);

export const LOCAL_ROUTER_ENABLED =
  (process.env.LOCAL_ROUTER_ENABLED ||
    envCfg.LOCAL_ROUTER_ENABLED ||
    'true') === 'true';

const OLLAMA_HOST =
  process.env.OLLAMA_HOST || envCfg.OLLAMA_HOST || 'http://127.0.0.1:11434';

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ||
  envCfg.OLLAMA_MODEL ||
  'qwen2.5:7b-instruct-q4_K_M';

const ESCALATE_TOKEN = 'ESCALATE';
const CLARIFY_PREFIX = 'CLARIFY:';
const SEARCH_PREFIX = 'SEARCH:';

/** Label appended to every local response */
export const LOCAL_LABEL = '— local';
/** Label appended to every Claude response */
export const CLAUDE_LABEL = '— Claude';

const SYSTEM_PROMPT = `You are ${ASSISTANT_NAME}, a helpful personal AI assistant. You receive a conversation and must decide how to respond.

You have THREE options:

**Option 1 — ANSWER DIRECTLY** if the message is:
- Casual conversation, greetings, simple questions
- Quick factual lookups you're confident about
- Summaries, rewrites, or text formatting
- Simple math or unit conversions
- Short creative tasks (jokes, haiku, etc.)
Just write your response normally.

**Option 2 — WEB SEARCH THEN ESCALATE** (respond with "SEARCH: <optimal search query>") when:
- The message asks about current events, news, prices, weather, or anything time-sensitive
- The message asks for facts you're not confident about
- Research or analysis would clearly benefit from fresh web results
- Choose the most effective search query to get useful results

**Option 3 — ESCALATE** (respond with only the word ESCALATE, nothing else) if the message requires:
- Writing or debugging code
- Deep multi-step reasoning or planning
- Tool use (managing files, scheduling tasks, agentic tasks like "go do X")
- Anything that doesn't need web context and is beyond your capability

**Option 4 — ASK A CLARIFYING QUESTION** (respond with "CLARIFY: <your question>") when:
- The task clearly needs the powerful AI, BUT a specific detail is missing
- Examples: language not specified for a coding task, ambiguous scope
- Only ask ONE focused question. Don't ask if the message is already clear.

Be conservative: when in doubt between answering and searching, search. When in doubt between searching and escalating, search first.`;

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

export type RouterResult =
  | { type: 'answer'; text: string }
  | { type: 'search'; query: string }
  | { type: 'clarify'; question: string }
  | { type: 'escalate' };

/**
 * Extract plain-text messages from the XML-formatted prompt.
 * Qwen gets confused by raw XML — we give it just the conversation text.
 */
function extractPlainText(xmlPrompt: string): string {
  // Pull all <message ...>content</message> blocks and join them
  const matches = [...xmlPrompt.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  if (matches.length === 0) return xmlPrompt; // fallback: pass as-is
  return matches.map((m) => m[1].trim()).join('\n');
}

/**
 * Ask the local model what to do with this conversation.
 */
export async function queryLocalRouter(
  conversationText: string,
): Promise<RouterResult> {
  if (!LOCAL_ROUTER_ENABLED) return { type: 'escalate' };

  const plainText = extractPlainText(conversationText);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0.7, num_predict: 512 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: plainText },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'Local router: Ollama error, escalating to Claude',
      );
      return { type: 'escalate' };
    }

    const data = (await res.json()) as OllamaResponse;
    const reply = data.message?.content?.trim() ?? '';

    if (!reply || reply.toUpperCase() === ESCALATE_TOKEN) {
      logger.info({ input: plainText.slice(0, 80) }, 'Local router: escalating to Claude');
      return { type: 'escalate' };
    }

    if (reply.toUpperCase().startsWith(SEARCH_PREFIX)) {
      const query = reply.slice(SEARCH_PREFIX.length).trim();
      logger.info({ query }, 'Local router: web search before escalating');
      return { type: 'search', query };
    }

    if (reply.toUpperCase().startsWith(CLARIFY_PREFIX)) {
      const question = reply.slice(CLARIFY_PREFIX.length).trim();
      logger.info({ question }, 'Local router: requesting clarification');
      return { type: 'clarify', question };
    }

    logger.info(
      { model: OLLAMA_MODEL, replyLen: reply.length },
      'Local router: handled locally',
    );
    return { type: 'answer', text: reply };
  } catch (err) {
    logger.warn({ err }, 'Local router: unavailable, escalating to Claude');
    return { type: 'escalate' };
  }
}

/**
 * Check if Ollama is running and the model is available.
 */
export async function checkLocalRouter(): Promise<{
  available: boolean;
  model: string;
  error?: string;
}> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok)
      return {
        available: false,
        model: OLLAMA_MODEL,
        error: `HTTP ${res.status}`,
      };

    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    const hasModel = models.some(
      (m) =>
        m.name === OLLAMA_MODEL ||
        m.name.startsWith(OLLAMA_MODEL.split(':')[0]),
    );

    if (!hasModel) {
      return {
        available: false,
        model: OLLAMA_MODEL,
        error: `Model ${OLLAMA_MODEL} not found. Run: ollama pull ${OLLAMA_MODEL}`,
      };
    }

    return { available: true, model: OLLAMA_MODEL };
  } catch (err) {
    return { available: false, model: OLLAMA_MODEL, error: String(err) };
  }
}
