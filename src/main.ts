import * as utils from '@iobroker/adapter-core';

import { BraviaDevice } from './device';
import type { BraviaError } from './lib/errors';
import { DEFAULT_POLL_SECONDS, nextRetrySeconds, pollSecondsFrom, timeoutSecondsFrom } from './lib/config';
import { IoBrokerStateStore } from './lib/iobroker-store';
import { BraviaRestClient } from './transport/rest-client';
import type { SsipMessage } from './transport/ssip-protocol';

/** Consecutive poll failures tolerated before `info.connection` is cleared. */
const POLL_FAILURES_BEFORE_DISCONNECT = 2;

class ProBraviaAdapter extends utils.Adapter {
    private device: BraviaDevice | null = null;
    private store: IoBrokerStateStore | null = null;
    private pollTimer: ioBroker.Timeout | undefined;
    private pollSeconds = DEFAULT_POLL_SECONDS;
    private polling = false;
    /**
     * Consecutive failed polls. `info.connection` only flips after two, so a single timeout
     * or blip does not tell every watchdog the display has gone.
     */
    private pollFailures = 0;
    /** Current startup-retry delay, doubling on each failure. Zero means "not yet failing". */
    private retryDelaySeconds = 0;
    /** Whether the current run of startup failures has already been reported at warn/error. */
    private startupFailureLogged = false;
    private retryTimer: ioBroker.Timeout | undefined;
    private unloading = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'pro-bravia' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        const host = (this.config.host ?? '').trim();
        if (!host) {
            this.log.error('No display address configured. Open the instance settings and enter the display IP.');
            return;
        }
        if (!this.config.psk) {
            this.log.warn(
                'No pre-shared key configured. Most control APIs require one; ' +
                    'set it on the display under Network & Internet > Home network > IP control > Authentication.',
            );
        }

        this.pollSeconds = pollSecondsFrom(this.config.pollInterval);

        this.store = new IoBrokerStateStore(this);
        this.device = new BraviaDevice(
            {
                host,
                psk: this.config.psk ?? '',
                httpPort: this.config.httpPort || 80,
                requestTimeoutMs: timeoutSecondsFrom(this.config.requestTimeout) * 1000,
                useSsip: this.config.useSsip !== false,
                ssipPort: this.config.ssipPort || 20060,
                useIrcc: this.config.useIrcc !== false,
                macAddress: this.config.macAddress || undefined,
                broadcastAddress: this.config.broadcastAddress || undefined,
                timers: {
                    schedule: (callback, milliseconds) => this.setTimeout(callback, milliseconds),
                    cancel: handle => this.clearTimeout(handle as ioBroker.Timeout),
                },
            },
            this.store,
        );

        this.attachSsip();
        this.subscribeStates('*');
        await this.initialiseDevice();
    }

    private attachSsip(): void {
        const ssip = this.device?.ssip;
        if (!ssip) {
            return;
        }

        ssip.on('connect', () => {
            this.log.info('Simple IP Control connected');
            void this.setState('info.ssipConnection', { val: true, ack: true });
        });
        ssip.on('disconnect', () => {
            this.log.warn('Simple IP Control disconnected; reconnecting');
            void this.setState('info.ssipConnection', { val: false, ack: true });
        });
        ssip.on('error', error => {
            this.log.debug(`Simple IP Control: ${error.message}`);
        });
        ssip.on('notify', (message: SsipMessage) => {
            void this.device?.handleNotify(message);
        });

        ssip.connect();
    }

    /**
     * Discover the display and build its state tree. Retries on its own schedule so a display
     * that is powered down or still booting does not leave the adapter permanently dead.
     */
    private async initialiseDevice(): Promise<void> {
        if (!this.device || this.unloading) {
            return;
        }

        try {
            await this.device.initialise();
            if (this.unloading) {
                return;
            }
            this.retryDelaySeconds = 0;
            this.startupFailureLogged = false;
            await this.setState('info.connection', { val: true, ack: true });
            this.log.info(`Connected to display at ${this.config.host}`);
            await this.device.refresh();
            if (this.unloading) {
                return;
            }
            this.startPolling();
        } catch (e) {
            if (this.unloading) {
                return;
            }
            const error = e as BraviaError;
            await this.setState('info.connection', { val: false, ack: true });

            // Report the first failure of a run properly, then drop to debug. A display that is
            // off at the wall, or a not-yet-corrected pre-shared key, would otherwise repeat the
            // same line every retry for as long as the instance runs.
            if (!this.startupFailureLogged) {
                this.startupFailureLogged = true;
                if (error.kind === 'auth') {
                    this.log.error(
                        `The display rejected the pre-shared key (${error.message}). ` +
                            'Check Network & Internet > Home network > IP control > Authentication on the display. ' +
                            'The adapter will keep retrying, so no restart is needed once it is corrected.',
                    );
                } else {
                    this.log.warn(`Could not reach the display: ${error.message}. Retrying in the background.`);
                }
            } else {
                this.log.debug(`Display still unreachable: ${error.message}`);
            }
            this.scheduleRetry();
        }
    }

    /**
     * Back off between startup attempts rather than hammering a display that is switched off.
     * Grows from the poll interval up to a ceiling, so a display that is only unplugged
     * overnight is still picked up within a few minutes of coming back.
     */
    private scheduleRetry(): void {
        if (this.retryTimer || this.unloading) {
            return;
        }
        this.retryDelaySeconds = nextRetrySeconds(this.retryDelaySeconds, this.pollSeconds);
        this.retryTimer = this.setTimeout(() => {
            this.retryTimer = undefined;
            void this.initialiseDevice();
        }, this.retryDelaySeconds * 1000);
    }

    /**
     * Re-arming timeout rather than setInterval: a full refresh against an unresponsive
     * display can exceed the interval, and setInterval would stack overlapping refreshes
     * onto the REST client's serialisation queue faster than they drain.
     */
    private startPolling(): void {
        if (this.pollTimer) {
            return;
        }
        this.scheduleNextPoll();
        this.log.debug(`Polling the display every ${this.pollSeconds}s`);
    }

    private scheduleNextPoll(): void {
        if (this.unloading) {
            return;
        }
        this.pollTimer = this.setTimeout(() => {
            this.pollTimer = undefined;
            void this.poll();
        }, this.pollSeconds * 1000);
    }

    private async poll(): Promise<void> {
        if (!this.device?.isReady || this.unloading || this.polling) {
            return;
        }
        this.polling = true;
        try {
            await this.device.refresh();
            if (this.unloading) {
                return;
            }
            this.pollFailures = 0;
            await this.setState('info.connection', { val: true, ack: true });
        } catch (e) {
            if (this.unloading) {
                return;
            }
            const error = e as BraviaError;
            this.pollFailures++;
            if (this.pollFailures === POLL_FAILURES_BEFORE_DISCONNECT) {
                this.log.warn(`Display is not responding: ${error.message}`);
                await this.setState('info.connection', { val: false, ack: true });
            } else {
                this.log.debug(`Poll failed (${this.pollFailures}): ${error.message}`);
            }
        } finally {
            this.polling = false;
            this.scheduleNextPoll();
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        // ack:true is the adapter's own confirmation of a value; only unacknowledged writes
        // are user commands that need sending to the display.
        if (!state || state.ack || !this.device) {
            return;
        }

        const relative = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;

        try {
            const handled = await this.device.write(relative, state.val);
            if (!handled) {
                this.log.warn(`No handler for state ${relative}; the command was ignored`);
                return;
            }
            // Buttons are momentary: acknowledging them would leave them stuck "pressed".
            const object = await this.getObjectAsync(relative);
            if (object?.common?.role !== 'button') {
                await this.setState(relative, { val: state.val, ack: true });
            }
        } catch (e) {
            const error = e as BraviaError;
            this.log.error(`Failed to apply ${relative} = ${String(state.val)}: ${error.message}`);
            await this.setState('info.lastError', { val: `${relative}: ${error.message}`, ack: true });
        }
    }

    /**
     * Admin "test connection" button.
     *
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (obj.command !== 'testConnection') {
            return;
        }

        const config = (obj.message ?? {}) as { host?: string; psk?: string; httpPort?: number };
        const host = (config.host ?? '').trim();
        if (!host) {
            this.respond(obj, { error: 'Enter the display address first' });
            return;
        }

        const client = new BraviaRestClient({
            host,
            psk: config.psk ?? '',
            port: config.httpPort || 80,
            timeoutMs: 5000,
        });

        try {
            const info = await client.callFirst<{ model?: string; serial?: string; generation?: string }>(
                'system',
                'getSystemInformation',
            );
            this.respond(obj, {
                result: `Connected to ${info.model ?? 'display'} (serial ${info.serial ?? 'unknown'}, generation ${info.generation ?? 'unknown'})`,
            });
        } catch (e) {
            const error = e as BraviaError;
            this.respond(obj, {
                error:
                    error.kind === 'auth'
                        ? 'The display rejected the pre-shared key'
                        : `Could not reach the display: ${error.message}`,
            });
        }
    }

    private respond(obj: ioBroker.Message, payload: Record<string, unknown>): void {
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, payload, obj.callback);
        }
    }

    private onUnload(callback: () => void): void {
        this.unloading = true;
        try {
            // Stop the device first so any in-flight discovery or refresh stops writing.
            this.device?.stop();
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
            if (this.retryTimer) {
                this.clearTimeout(this.retryTimer);
                this.retryTimer = undefined;
            }
            this.device?.ssip?.removeAllListeners();
            this.device?.ssip?.close();
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ProBraviaAdapter(options);
} else {
    (() => new ProBraviaAdapter())();
}
