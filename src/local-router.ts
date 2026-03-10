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

**Option 2 — ESCALATE** (respond with only the word ESCALATE, nothing else) if the message requires:
- Writing or debugging code
- Deep research or analysis
- Tool use (browsing the web, managing files, scheduling tasks)
- Any agentic task ("go do X", "set up Y", "find and fix Z")
- Anything you're genuinely unsure about

**Option 3 — ASK A CLARIFYING QUESTION** (respond with "CLARIFY: <your question>") when:
- The message is clearly meant for the powerful AI (coding, research, agentic)
- BUT a specific detail is missing that would make the answer significantly better
- Examples: the language isn't specified for a coding task, the scope is unclear for a research task, ambiguous intent that changes the entire answer
- Only ask ONE focused question. Don't ask if the message is already clear enough.

Be conservative: when in doubt between answering and escalating, escalate.`;

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

export type RouterResult =
  | { type: 'answer'; text: string }
  | { type: 'clarify'; question: string }
  | { type: 'escalate' };

/**
 * Ask the local model what to do with this conversation.
 */
export async function queryLocalRouter(
  conversationText: string,
): Promise<RouterResult> {
  if (!LOCAL_ROUTER_ENABLED) return { type: 'escalate' };

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
          { role: 'user', content: conversationText },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.debug({ status: res.status }, 'Local router: Ollama error, escalating');
      return { type: 'escalate' };
    }

    const data = (await res.json()) as OllamaResponse;
    const reply = data.message?.content?.trim() ?? '';

    if (!reply || reply.toUpperCase() === ESCALATE_TOKEN) {
      logger.debug('Local router: escalating to Claude');
      return { type: 'escalate' };
    }

    if (reply.toUpperCase().startsWith(CLARIFY_PREFIX)) {
      const question = reply.slice(CLARIFY_PREFIX.length).trim();
      logger.info({ question }, 'Local router: requesting clarification');
      return { type: 'clarify', question };
    }

    logger.info({ model: OLLAMA_MODEL, replyLen: reply.length }, 'Local router: handled locally');
    return { type: 'answer', text: reply };
  } catch (err) {
    logger.debug({ err }, 'Local router: unavailable, escalating to Claude');
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
      return { available: false, model: OLLAMA_MODEL, error: `HTTP ${res.status}` };

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
