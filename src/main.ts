import * as utils from '@iobroker/adapter-core';

import { BraviaDevice } from './device';
import type { BraviaError } from './lib/errors';
import { IoBrokerStateStore } from './lib/iobroker-store';
import { BraviaRestClient } from './transport/rest-client';
import type { SsipMessage } from './transport/ssip-protocol';

class ProBraviaAdapter extends utils.Adapter {
    private device: BraviaDevice | null = null;
    private store: IoBrokerStateStore | null = null;
    private pollTimer: ioBroker.Interval | undefined;
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

        this.store = new IoBrokerStateStore(this);
        this.device = new BraviaDevice(
            {
                host,
                psk: this.config.psk ?? '',
                httpPort: this.config.httpPort || 80,
                requestTimeoutMs: (this.config.requestTimeout || 5) * 1000,
                useSsip: this.config.useSsip !== false,
                ssipPort: this.config.ssipPort || 20060,
                useIrcc: this.config.useIrcc !== false,
                macAddress: this.config.macAddress || undefined,
                broadcastAddress: this.config.broadcastAddress || undefined,
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
            await this.setState('info.connection', { val: true, ack: true });
            this.log.info(`Connected to display at ${this.config.host}`);
            await this.device.refresh();
            this.startPolling();
        } catch (e) {
            const error = e as BraviaError;
            await this.setState('info.connection', { val: false, ack: true });
            if (error.kind === 'auth') {
                this.log.error(
                    `The display rejected the pre-shared key (${error.message}). ` +
                        'Check Network & Internet > Home network > IP control > Authentication on the display.',
                );
            } else {
                this.log.warn(`Could not initialise the display: ${error.message}. Retrying shortly.`);
            }
            this.scheduleRetry();
        }
    }

    private scheduleRetry(): void {
        if (this.retryTimer || this.unloading) {
            return;
        }
        const seconds = Math.max(10, this.config.pollInterval || 30);
        this.retryTimer = this.setTimeout(() => {
            this.retryTimer = undefined;
            void this.initialiseDevice();
        }, seconds * 1000);
    }

    private startPolling(): void {
        if (this.pollTimer) {
            return;
        }
        const seconds = Math.max(5, this.config.pollInterval || 30);
        this.pollTimer = this.setInterval(() => {
            void this.poll();
        }, seconds * 1000);
        this.log.debug(`Polling the display every ${seconds}s`);
    }

    private async poll(): Promise<void> {
        if (!this.device?.isReady || this.unloading) {
            return;
        }
        try {
            await this.device.refresh();
            await this.setState('info.connection', { val: true, ack: true });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.log.debug(`Poll failed: ${message}`);
            await this.setState('info.connection', { val: false, ack: true });
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
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
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
