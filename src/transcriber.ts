/**
 * Voice message transcription using OpenAI Whisper (local).
 *
 * Converts audio attachments from Signal (or other channels) to text
 * by calling the `whisper` CLI. Install via: sudo pacman -S python-openai-whisper
 * For GPU acceleration: sudo pacman -S python-pytorch-cuda
 */

import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envCfg = readEnvFile(['WHISPER_MODEL']);

const WHISPER_MODEL = process.env.WHISPER_MODEL || envCfg.WHISPER_MODEL || 'small';
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Audio MIME types we attempt to transcribe */
const AUDIO_CONTENT_TYPES = new Set([
  'audio/aac',
  'audio/mp4',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/wav',
  'audio/flac',
]);

export function isAudioContentType(contentType: string): boolean {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return AUDIO_CONTENT_TYPES.has(base) || base.startsWith('audio/');
}

/**
 * Transcribe an audio file to text using Whisper.
 * Returns null if transcription fails or produces no output.
 */
export async function transcribeAudio(filePath: string): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const basename = path.basename(filePath, path.extname(filePath));
  const outFile = path.join(tmpDir, `${basename}.txt`);

  logger.info({ filePath, model: WHISPER_MODEL }, 'Transcriber: starting');

  return new Promise((resolve) => {
    const proc = spawn(
      'whisper',
      [
        filePath,
        '--model', WHISPER_MODEL,
        '--output_format', 'txt',
        '--output_dir', tmpDir,
        '--fp16', 'False',
        '--verbose', 'False',
      ],
      { timeout: TRANSCRIBE_TIMEOUT_MS },
    );

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(-200) }, 'Transcriber: whisper exited with error');
        resolve(null);
        return;
      }
      try {
        const text = readFileSync(outFile, 'utf8').trim();
        if (text) {
          logger.info({ chars: text.length }, 'Transcriber: done');
          resolve(text);
        } else {
          logger.warn('Transcriber: empty output');
          resolve(null);
        }
      } catch (err) {
        logger.warn({ err }, 'Transcriber: could not read output file');
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      logger.warn({ err }, 'Transcriber: failed to start whisper (is it installed?)');
      resolve(null);
    });
  });
}
