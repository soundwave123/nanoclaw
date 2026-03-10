import net from 'net';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

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
const SIGNAL_CLI_USE_SOCKET = !!envCfg.SIGNAL_CLI_SOCKET || !!process.env.SIGNAL_CLI_SOCKET;
const SIGNAL_CLI_TCP_HOST =
  process.env.SIGNAL_CLI_TCP_HOST || envCfg.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
const SIGNAL_CLI_TCP_PORT = parseInt(
  process.env.SIGNAL_CLI_TCP_PORT || envCfg.SIGNAL_CLI_TCP_PORT || '7583',
  10,
);

const JID_PREFIX = 'signal:';
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

function toJid(identifier: string): string {
  return `${JID_PREFIX}${identifier}`;
}

function fromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
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
        : ({ host: SIGNAL_CLI_TCP_HOST, port: SIGNAL_CLI_TCP_PORT } as net.TcpNetConnectOpts);

      logger.info({ connectOpts }, 'Signal: connecting to signal-cli daemon');

      sock.connect(connectOpts, () => {
        logger.info('Signal: connected to signal-cli daemon');
        this._connected = true;
        this.reconnectDelay = RECONNECT_DELAY_MS;
        this.subscribeReceive()
          .then(resolve)
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
        this.handleEnvelope(params.envelope as Record<string, unknown>);
      }
    }
  }

  private handleEnvelope(envelope: Record<string, unknown>): void {
    const dm = envelope.dataMessage as Record<string, unknown> | undefined;
    if (!dm?.message || typeof dm.message !== 'string') return;

    const source =
      (envelope.source as string) ||
      (envelope.sourceNumber as string) ||
      '';
    if (!source) return;

    const groupInfo = dm.groupInfo as Record<string, unknown> | undefined;
    const groupId =
      typeof groupInfo?.groupId === 'string' ? groupInfo.groupId : null;

    const jid = groupId ? toJid(`group.${groupId}`) : toJid(source);
    const tsRaw = envelope.timestamp;
    const timestamp =
      typeof tsRaw === 'number'
        ? new Date(tsRaw).toISOString()
        : new Date().toISOString();

    const sourceName =
      typeof envelope.sourceName === 'string' ? envelope.sourceName : source;
    const isFromMe = source === SIGNAL_PHONE_NUMBER;

    this.onChatMetadata(jid, timestamp, undefined, 'signal', !!groupId);
    this.onMessage(jid, {
      id: `signal_${tsRaw ?? Date.now()}_${source}`,
      chat_jid: jid,
      sender: source,
      sender_name: sourceName,
      content: dm.message,
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
    this.socket?.destroy();
    this._connected = false;
  }
}

registerChannel('signal', (opts: ChannelOpts): Channel | null => {
  if (!SIGNAL_PHONE_NUMBER) return null;
  return new SignalChannel(opts);
});
