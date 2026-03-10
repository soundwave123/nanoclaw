/**
 * Text-to-speech using piper (local, fast, high-quality).
 * Install: see scripts/install-piper.sh or ~/.local/bin/piper/piper
 * Voice models stored in ~/.local/share/piper-voices/
 */

import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { rmSync } from 'fs';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envCfg = readEnvFile(['PIPER_VOICE', 'PIPER_BIN']);

const PIPER_BIN =
  process.env.PIPER_BIN ||
  envCfg.PIPER_BIN ||
  path.join(os.homedir(), '.local/bin/piper/piper');

const PIPER_VOICE =
  process.env.PIPER_VOICE ||
  envCfg.PIPER_VOICE ||
  path.join(os.homedir(), '.local/share/piper-voices/en_US-lessac-medium.onnx');

const TTS_TIMEOUT_MS = 30_000;

/**
 * Synthesize text to a WAV file.
 * Returns the output file path, or null on failure.
 * Caller is responsible for deleting the file when done.
 */
export async function synthesizeSpeech(text: string): Promise<string | null> {
  const outFile = path.join(os.tmpdir(), `tts-${Date.now()}.wav`);

  logger.info({ chars: text.length }, 'TTS: synthesizing');

  return new Promise((resolve) => {
    const proc = spawn(
      PIPER_BIN,
      ['--model', PIPER_VOICE, '--output_file', outFile],
      { timeout: TTS_TIMEOUT_MS },
    );

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.stdin.write(text);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(-200) }, 'TTS: piper failed');
        resolve(null);
        return;
      }
      logger.info({ outFile }, 'TTS: done');
      resolve(outFile);
    });

    proc.on('error', (err) => {
      logger.warn({ err }, 'TTS: failed to start piper (is it installed?)');
      resolve(null);
    });
  });
}

/** Synthesize and return the file path, cleaning up after a delay. */
export async function synthesizeAndCleanup(
  text: string,
  delayMs = 30_000,
): Promise<string | null> {
  const file = await synthesizeSpeech(text);
  if (file) {
    setTimeout(() => {
      try {
        rmSync(file);
      } catch {}
    }, delayMs);
  }
  return file;
}
