import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { isAudioContentType, transcribeAudio } from '../transcriber.js';
import { Channel, OnChatMetadata, OnInboundMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

/** Default directory where signal-cli stores received attachments */
const SIGNAL_ATTACHMENTS_DIR = path.join(
  os.homedir(),
  '.local/share/signal-cli/attachments',
);

const envCfg = readEnvFile([
  'SIGNAL_PHONE_NUMBER',
  'SIGNAL_CLI_SOCKET',
  'SIGNAL_CLI_TCP_HOST',
  'SIGNAL_CLI_TCP_PORT',
]);

const SIGNAL_PHONE_NUMBER =
  process.env.SIGNAL_PHONE_NUMBER || envCfg.SIGNAL_PHONE_NUMBER;
const SIGNAL_CLI_SOCKET =
  process.env.SIGNAL_CLI_SOCKET ||
  envCfg.SIGNAL_CLI_SOCKET ||
  '/var/run/signal-cli/socket';
const SIGNAL_CLI_USE_SOCKET =
  !!envCfg.SIGNAL_CLI_SOCKET || !!process.env.SIGNAL_CLI_SOCKET;
const SIGNAL_CLI_TCP_HOST =
  process.env.SIGNAL_CLI_TCP_HOST || envCfg.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
const SIGNAL_CLI_TCP_PORT = parseInt(
  process.env.SIGNAL_CLI_TCP_PORT || envCfg.SIGNAL_CLI_TCP_PORT || '7583',
  10,
);

const JID_PREFIX = 'signal:';
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;
const POLL_INTERVAL_MS = 2000;

function toJid(identifier: string): string {
  return `${JID_PREFIX}${identifier}`;
}

function fromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

/**
 * Resolve an attachment object to a local filesystem path.
 * signal-cli may provide an absolute storedFilename or just a basename.
 */
function resolveAttachmentPath(attachment: Record<string, unknown>): string | null {
  const stored = attachment.storedFilename ?? attachment.filename ?? attachment.id;
  if (typeof stored !== 'string' || !stored) return null;

  if (path.isAbsolute(stored)) {
      return existsSync(stored) ? stored : null;
  }

  // Try with and without the content-type-derived extension
  const candidates = [
    path.join(SIGNAL_ATTACHMENTS_DIR, stored),
    // signal-cli sometimes stores as <id> without extension; try common audio exts
    path.join(SIGNAL_ATTACHMENTS_DIR, `${stored}.m4a`),
    path.join(SIGNAL_ATTACHMENTS_DIR, `${stored}.ogg`),
    path.join(SIGNAL_ATTACHMENTS_DIR, `${stored}.aac`),
  ];

  return candidates.find(existsSync) ?? null;
}

class SignalChannel implements Channel {
  name = 'signal';

  private socket: net.Socket | null = null;
  private _connected = false;
  private buffer = '';
  private requestId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private reconnectDelay = RECONNECT_DELAY_MS;
  private intentionalDisconnect = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      this.socket = sock;

      const connectOpts: net.NetConnectOpts = SIGNAL_CLI_USE_SOCKET
        ? ({ path: SIGNAL_CLI_SOCKET } as net.IpcNetConnectOpts)
        : ({
            host: SIGNAL_CLI_TCP_HOST,
            port: SIGNAL_CLI_TCP_PORT,
          } as net.TcpNetConnectOpts);

      logger.info({ connectOpts }, 'Signal: connecting to signal-cli daemon');

      sock.connect(connectOpts, () => {
        logger.info('Signal: connected to signal-cli daemon');
        this._connected = true;
        this.reconnectDelay = RECONNECT_DELAY_MS;
        this.subscribeReceive()
          .then(() => {
            this.startPolling();
            resolve();
          })
          .catch((err) => {
            logger.error({ err }, 'Signal: subscribeReceive failed');
            reject(err);
          });
      });

      sock.on('data', (data) => this.handleData(data.toString()));

      sock.on('error', (err) => {
        logger.error({ err }, 'Signal: socket error');
        if (!this._connected) reject(err);
      });

      sock.on('close', () => {
        if (this._connected) {
          logger.warn('Signal: socket closed');
        }
        this._connected = false;
        // Reject any pending requests
        for (const [, { reject: rej }] of this.pendingRequests) {
          rej(new Error('Signal socket closed'));
        }
        this.pendingRequests.clear();

        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    logger.info(
      { delayMs: this.reconnectDelay },
      'Signal: scheduling reconnect',
    );
    setTimeout(() => {
      if (!this.intentionalDisconnect) {
        this.doConnect().catch((err) => {
          logger.error({ err }, 'Signal: reconnect failed');
          this.reconnectDelay = Math.min(
            this.reconnectDelay * 2,
            MAX_RECONNECT_DELAY_MS,
          );
          this.scheduleReconnect();
        });
      }
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      MAX_RECONNECT_DELAY_MS,
    );
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleJsonRpc(msg);
      } catch {
        logger.warn({ line }, 'Signal: failed to parse JSON-RPC message');
      }
    }
  }

  private handleJsonRpc(msg: Record<string, unknown>): void {
    // Response to a pending request
    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        this.pendingRequests.delete(msg.id as number);
        if (msg.error) {
          const err = msg.error as Record<string, unknown>;
          pending.reject(
            new Error(
              typeof err.message === 'string'
                ? err.message
                : JSON.stringify(err),
            ),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Push notification (incoming message event)
    if (msg.method === 'receive') {
      const params = msg.params as Record<string, unknown> | undefined;
      if (params?.envelope) {
        this.handleEnvelope(params.envelope as Record<string, unknown>).catch((err) =>
          logger.error({ err }, 'Signal: error handling envelope'),
        );
      }
    }
  }

  private async handleEnvelope(envelope: Record<string, unknown>): Promise<void> {
    // Regular incoming message from another party
    const dm = envelope.dataMessage as Record<string, unknown> | undefined;
    // Sync message: copy of a message sent from the primary device
    const sync = envelope.syncMessage as Record<string, unknown> | undefined;
    const sent = sync?.sentMessage as Record<string, unknown> | undefined;

    // Resolve message body from whichever field is present
    const msgBody = dm ?? sent;

    // Determine message text — either the text body or a transcribed voice message
    let messageText = typeof msgBody?.message === 'string' ? msgBody.message : '';

    if (!messageText) {
      const attachments = msgBody?.attachments as
        | Array<Record<string, unknown>>
        | undefined;
      const audio = attachments?.find(
        (a) => typeof a.contentType === 'string' && isAudioContentType(a.contentType),
      );
      if (audio) {
        const filePath = resolveAttachmentPath(audio);
        if (filePath) {
          const transcription = await transcribeAudio(filePath);
          if (transcription) messageText = transcription;
        } else {
          logger.warn({ audio }, 'Signal: audio attachment file not found');
        }
      }
    }

    if (!messageText) return;

    const source =
      (envelope.source as string) || (envelope.sourceNumber as string) || '';

    const isSyncSent = !!sent && !dm;
    // For sync/sent messages the chat is identified by the destination, not source
    const chatNumber = isSyncSent
      ? (sent!.destination as string) ||
        (sent!.destinationNumber as string) ||
        source
      : source;

    if (!chatNumber) return;

    const groupInfo = msgBody?.groupInfo as Record<string, unknown> | undefined;
    const groupId =
      typeof groupInfo?.groupId === 'string' ? groupInfo.groupId : null;

    const jid = groupId ? toJid(`group.${groupId}`) : toJid(chatNumber);
    const tsRaw =
      (envelope.timestamp as number | undefined) ??
      (sent?.timestamp as number | undefined);
    const timestamp =
      typeof tsRaw === 'number'
        ? new Date(tsRaw).toISOString()
        : new Date().toISOString();

    const effectiveSource = isSyncSent
      ? source || SIGNAL_PHONE_NUMBER || chatNumber
      : source;
    const sourceName =
      typeof envelope.sourceName === 'string'
        ? envelope.sourceName
        : effectiveSource;
    const isFromMe = isSyncSent || effectiveSource === SIGNAL_PHONE_NUMBER;

    this.onChatMetadata(jid, timestamp, undefined, 'signal', !!groupId);
    this.onMessage(jid, {
      id: `signal_${tsRaw ?? Date.now()}_${effectiveSource}`,
      chat_jid: jid,
      sender: effectiveSource,
      sender_name: sourceName,
      content: messageText,
      timestamp,
      is_from_me: isFromMe,
    });
  }

  private rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    const payload =
      JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n';
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._connected) {
        reject(new Error('Signal: not connected'));
        return;
      }
      this.pendingRequests.set(id, { resolve, reject });
      this.socket.write(payload);
    });
  }

  private async subscribeReceive(): Promise<void> {
    await this.rpc('subscribeReceive');
    logger.info('Signal: subscribed to incoming messages');
  }

  private startPolling(): void {
    // Poll via receive RPC to capture sync messages (Note to Self, etc.)
    // that signal-cli doesn't push via subscribeReceive notifications.
    const poll = async () => {
      if (this.intentionalDisconnect || !this._connected) return;
      try {
        const result = await this.rpc('receive', {
          account: SIGNAL_PHONE_NUMBER,
        });
        if (Array.isArray(result)) {
          for (const item of result) {
            const env = (item as Record<string, unknown>).envelope;
            if (env)
              this.handleEnvelope(env as Record<string, unknown>).catch((err) =>
                logger.error({ err }, 'Signal: error handling polled envelope'),
              );
          }
        }
      } catch {
        // ignore poll errors — socket close already handles reconnect
      }
      if (!this.intentionalDisconnect) {
        this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const identifier = fromJid(jid);
    const isGroup = identifier.startsWith('group.');
    const params = isGroup
      ? { groupId: identifier.slice('group.'.length), message: text }
      : { recipient: [identifier], message: text };
    await this.rpc('send', params);
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.socket?.destroy();
    this._connected = false;
  }
}

registerChannel('signal', (opts: ChannelOpts): Channel | null => {
  if (!SIGNAL_PHONE_NUMBER) return null;
  return new SignalChannel(opts);
});
