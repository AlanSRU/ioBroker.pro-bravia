import { EventEmitter } from 'node:events';
import * as net from 'node:net';

import { BraviaError } from '../lib/errors';
import { type TimerApi, type TimerHandle, systemTimers } from '../lib/timers';
import {
    PARAM_NONE,
    SSIP_PORT,
    type SsipMessage,
    decodeStream,
    encodeControl,
    encodeEnquiry,
    encodeMessage,
    isErrorAnswer,
    isNotFoundAnswer,
} from './ssip-protocol';

/**
 * Simple IP Control transport: a long-lived TCP connection to port 20060.
 *
 * Two jobs:
 *  - issue Control/Enquiry commands and await the matching Answer
 *  - surface unsolicited Notify frames, which are the only push feedback the display offers
 *
 * SSIP has no request identifier, so answers can only be matched by FourCC. Commands are
 * therefore issued strictly one at a time.
 */

export interface SsipClientOptions {
    host: string;
    port?: number;
    /** How long to wait for an Answer before giving up on a command. */
    commandTimeoutMs?: number;
    /** First reconnect delay; doubles up to `maxReconnectDelayMs`. */
    reconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    /** Framework timers. The adapter passes its own so pending timers die with the instance. */
    timers?: TimerApi;
}

interface PendingCommand {
    command: string;
    resolve: (message: SsipMessage) => void;
    reject: (error: Error) => void;
    timer: TimerHandle;
}

export declare interface SsipClient {
    on(event: 'connect', listener: () => void): this;
    on(event: 'disconnect', listener: () => void): this;
    on(event: 'notify', listener: (message: SsipMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

export class SsipClient extends EventEmitter {
    private socket: net.Socket | null = null;
    private buffer = Buffer.alloc(0);
    private pending: PendingCommand | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private reconnectTimer: TimerHandle = null;
    private reconnectDelay: number;
    private closed = false;
    private connected = false;

    private readonly host: string;
    private readonly port: number;
    private readonly commandTimeoutMs: number;
    private readonly initialReconnectDelay: number;
    private readonly maxReconnectDelay: number;
    private readonly timers: TimerApi;

    public constructor(options: SsipClientOptions) {
        super();
        this.host = options.host;
        this.port = options.port ?? SSIP_PORT;
        this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
        this.initialReconnectDelay = options.reconnectDelayMs ?? 5000;
        this.maxReconnectDelay = options.maxReconnectDelayMs ?? 60000;
        this.reconnectDelay = this.initialReconnectDelay;
        this.timers = options.timers ?? systemTimers;
    }

    public get isConnected(): boolean {
        return this.connected;
    }

    /** Open the connection and keep it open, reconnecting until {@link close} is called. */
    public connect(): void {
        this.closed = false;
        this.openSocket();
    }

    private openSocket(): void {
        if (this.closed || this.socket) {
            return;
        }

        const socket = new net.Socket();
        this.socket = socket;
        this.buffer = Buffer.alloc(0);

        socket.on('connect', () => {
            this.connected = true;
            this.reconnectDelay = this.initialReconnectDelay;
            this.emit('connect');
        });

        socket.on('data', chunk => this.consume(chunk));

        socket.on('error', error => {
            // 'close' always follows, so reconnection is handled there.
            this.emitError(error);
        });

        socket.on('close', () => {
            const wasConnected = this.connected;
            this.connected = false;
            this.socket = null;
            this.failPending(new BraviaError('SSIP connection closed', 'transport'));
            if (wasConnected) {
                this.emit('disconnect');
            }
            this.scheduleReconnect();
        });

        socket.connect(this.port, this.host);
    }

    /**
     * Emit an error without ever throwing. Node's EventEmitter rethrows an unhandled `'error'`
     * event, which would take the adapter down on a routine ECONNRESET from the display.
     *
     */
    private emitError(error: Error): void {
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        }
    }

    private consume(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const { messages, rest } = decodeStream(this.buffer);
        this.buffer = rest;

        for (const message of messages) {
            if (message.type === 'N') {
                this.emit('notify', message);
                continue;
            }
            if (message.type === 'A') {
                // Answers carry no id; match the single outstanding command by FourCC.
                if (this.pending && this.pending.command === message.command) {
                    const pending = this.pending;
                    this.pending = null;
                    this.timers.cancel(pending.timer);
                    pending.resolve(message);
                }
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = this.timers.schedule(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }

    private failPending(error: Error): void {
        if (!this.pending) {
            return;
        }
        const pending = this.pending;
        this.pending = null;
        this.timers.cancel(pending.timer);
        pending.reject(error);
    }

    /**
     * Send a Control command and resolve with the Answer.
     *
     */
    public control(command: string, parameter: string = PARAM_NONE): Promise<SsipMessage> {
        return this.send(command, encodeControl(command, parameter));
    }

    /**
     * Send an Enquiry and resolve with the Answer.
     *
     */
    public enquire(command: string, parameter?: string): Promise<SsipMessage> {
        const frame = parameter === undefined ? encodeEnquiry(command) : encodeMessage('E', command, parameter);
        return this.send(command, frame);
    }

    private send(command: string, frame: Buffer): Promise<SsipMessage> {
        const run = (): Promise<SsipMessage> =>
            new Promise<SsipMessage>((resolve, reject) => {
                if (!this.socket || !this.connected) {
                    reject(new BraviaError(`SSIP ${command}: not connected`, 'transport', undefined, command));
                    return;
                }
                const timer = this.timers.schedule(() => {
                    this.pending = null;
                    reject(new BraviaError(`SSIP ${command}: timed out`, 'retryable', undefined, command));
                }, this.commandTimeoutMs);

                this.pending = { command, resolve, reject, timer };
                this.socket.write(frame, error => {
                    if (error) {
                        this.failPending(
                            new BraviaError(`SSIP ${command}: ${error.message}`, 'transport', undefined, command),
                        );
                    }
                });
            });

        const result = this.queue.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }

    /**
     * Send a command and throw when the display answers with an error or "not found",
     * rather than handing the caller a success-shaped message.
     *
     */
    public async controlChecked(command: string, parameter: string = PARAM_NONE): Promise<void> {
        const answer = await this.control(command, parameter);
        if (isErrorAnswer(answer)) {
            throw new BraviaError(`SSIP ${command}: display returned an error`, 'badRequest', undefined, command);
        }
        if (isNotFoundAnswer(answer)) {
            throw new BraviaError(
                `SSIP ${command}: not available for the current input`,
                'unsupported',
                undefined,
                command,
            );
        }
    }

    /** Stop reconnecting and tear the socket down. */
    public close(): void {
        this.closed = true;
        if (this.reconnectTimer) {
            this.timers.cancel(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.failPending(new BraviaError('SSIP client closed', 'transport'));
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }
}
