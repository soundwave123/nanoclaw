/**
 * Local AI Router — uses Ollama to handle simple messages locally,
 * escalating to the Claude container only when needed.
 *
 * Routing decision is made by the local model itself: it either responds
 * directly (simple) or returns the special token ESCALATE (complex).
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
  (process.env.LOCAL_ROUTER_ENABLED || envCfg.LOCAL_ROUTER_ENABLED || 'true') === 'true';

const OLLAMA_HOST =
  process.env.OLLAMA_HOST || envCfg.OLLAMA_HOST || 'http://127.0.0.1:11434';

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || envCfg.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';

const ESCALATE_TOKEN = 'ESCALATE';

const SYSTEM_PROMPT = `You are ${ASSISTANT_NAME}, a helpful personal AI assistant. You will receive a conversation and must decide whether to answer it yourself or escalate to a more powerful AI.

RESPOND DIRECTLY if the message is:
- Casual conversation, greetings, simple questions
- Quick factual lookups you're confident about
- Summaries, rewrites, or text formatting
- Simple math or unit conversions
- Short creative tasks (jokes, haiku, etc.)

RESPOND WITH ONLY THE WORD "${ESCALATE_TOKEN}" (nothing else) if the message requires:
- Complex multi-step reasoning or planning
- Writing or debugging code
- Deep research or analysis
- Tool use (browsing the web, managing files, scheduling tasks)
- Any agentic task ("go do X", "set up Y", "find and fix Z")
- Anything you're genuinely unsure about

Be conservative: when in doubt, escalate. Your job is to handle the easy stuff so the powerful AI can focus on what really needs it.`;

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

/**
 * Attempt to handle a message locally.
 * Returns the response text if handled, or null if it should escalate to Claude.
 */
export async function tryLocalResponse(
  conversationText: string,
): Promise<string | null> {
  if (!LOCAL_ROUTER_ENABLED) return null;

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 512,
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: conversationText },
        ],
      }),
      signal: AbortSignal.timeout(15000), // 15s max for local response
    });

    if (!res.ok) {
      logger.debug({ status: res.status }, 'Local router: Ollama returned error, escalating');
      return null;
    }

    const data = (await res.json()) as OllamaResponse;
    const reply = data.message?.content?.trim() ?? '';

    if (!reply || reply.toUpperCase().startsWith(ESCALATE_TOKEN)) {
      logger.debug({ reply: reply.slice(0, 50) }, 'Local router: escalating to Claude');
      return null;
    }

    logger.info({ model: OLLAMA_MODEL, replyLen: reply.length }, 'Local router: handled locally');
    return reply;
  } catch (err) {
    // Ollama not available or timeout — silently fall through to Claude
    logger.debug({ err }, 'Local router: unavailable, escalating to Claude');
    return null;
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
    if (!res.ok) return { available: false, model: OLLAMA_MODEL, error: `HTTP ${res.status}` };

    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    const hasModel = models.some(
      (m) => m.name === OLLAMA_MODEL || m.name.startsWith(OLLAMA_MODEL.split(':')[0]),
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
