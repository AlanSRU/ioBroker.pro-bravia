import { AppControlModule } from './devices/appcontrol';
import { AudioModule } from './devices/audio';
import { AvContentModule } from './devices/avcontent';
import { RemoteModule } from './devices/remote';
import { SystemModule } from './devices/system';
import type { DeviceContext, FeatureModule } from './devices/types';
import { VideoModule } from './devices/video';
import { VideoScreenModule } from './devices/videoscreen';
import { Capabilities } from './discovery/capabilities';
import { BraviaError } from './lib/errors';
import type { StateStore } from './lib/state-store';
import { BraviaIrccClient } from './transport/ircc-client';
import { BraviaRestClient } from './transport/rest-client';
import { SsipClient } from './transport/ssip-client';
import type { SsipMessage } from './transport/ssip-protocol';

/**
 * One BRAVIA Professional Display, across all four of its control planes.
 *
 * Owns the transports, runs capability discovery once at startup, builds the state tree from
 * what the display reports, then routes writes out and notifications in.
 */

export interface BraviaDeviceOptions {
    host: string;
    psk: string;
    httpPort?: number;
    requestTimeoutMs?: number;
    useSsip: boolean;
    ssipPort?: number;
    useIrcc: boolean;
    macAddress?: string;
    broadcastAddress?: string;
}

export class BraviaDevice {
    public readonly rest: BraviaRestClient;
    public readonly ssip: SsipClient | null;
    public readonly ircc: BraviaIrccClient | null;

    private capabilities = Capabilities.fromServices([]);
    private modules: FeatureModule[] = [];
    /** Root channel -> the handler that owns writes beneath it. */
    private readonly writeHandlers = new Map<string, (path: string, value: ioBroker.StateValue) => Promise<boolean>>();
    private ready = false;

    public constructor(
        private readonly options: BraviaDeviceOptions,
        private readonly store: StateStore,
    ) {
        this.rest = new BraviaRestClient({
            host: options.host,
            psk: options.psk,
            port: options.httpPort,
            timeoutMs: options.requestTimeoutMs,
        });

        this.ssip = options.useSsip ? new SsipClient({ host: options.host, port: options.ssipPort }) : null;

        this.ircc = options.useIrcc
            ? new BraviaIrccClient({
                  host: options.host,
                  psk: options.psk,
                  port: options.httpPort,
                  timeoutMs: options.requestTimeoutMs,
              })
            : null;
    }

    private context(): DeviceContext {
        return {
            rest: this.rest,
            ssip: this.ssip,
            ircc: this.ircc,
            capabilities: this.capabilities,
            store: this.store,
            config: {
                host: this.options.host,
                macAddress: this.options.macAddress,
                broadcastAddress: this.options.broadcastAddress,
            },
            reportError: (error, context) => this.reportError(error, context),
        };
    }

    /**
     * Discover what the display supports and build the state tree from it.
     *
     * Called once the display is reachable. Safe to call again after a reconnection: object
     * creation is idempotent.
     */
    public async initialise(): Promise<void> {
        this.capabilities = await Capabilities.discover(this.rest);
        if (this.capabilities.assumed) {
            this.store.log.warn(
                'The display did not report its supported API list; assuming full support and ' +
                    'relying on per-call errors instead.',
            );
        } else {
            this.store.log.info(`Display supports services: ${this.capabilities.serviceNames.join(', ')}`);
        }

        const ctx = this.context();
        const system = new SystemModule(ctx);
        const audio = new AudioModule(ctx);
        const video = new VideoModule(ctx);
        const avContent = new AvContentModule(ctx);
        const videoScreen = new VideoScreenModule(ctx);
        const appControl = new AppControlModule(ctx);
        const remote = new RemoteModule(ctx);

        this.modules = [system, audio, video, avContent, videoScreen, appControl, remote];

        for (const module of this.modules) {
            try {
                await module.init();
            } catch (e) {
                this.reportError(e, `${module.name}.init`);
            }
        }

        this.writeHandlers.clear();
        this.writeHandlers.set('power', (path, value) => system.write(path, value));
        // The system module owns two roots: power control and system-level settings.
        this.writeHandlers.set('system', (path, value) => system.writeSystem(path, value));
        this.writeHandlers.set('audio', (path, value) => audio.write(path, value));
        this.writeHandlers.set('video', (path, value) => video.write(path, value));
        this.writeHandlers.set('input', (path, value) => avContent.write(path, value));
        this.writeHandlers.set('scene', (path, value) => videoScreen.write(path, value));
        this.writeHandlers.set('apps', (path, value) => appControl.write(path, value));
        this.writeHandlers.set('remote', (path, value) => remote.write(path, value));

        this.ready = true;
    }

    /** Re-read every value the display exposes. */
    public async refresh(): Promise<void> {
        if (!this.ready) {
            return;
        }
        for (const module of this.modules) {
            try {
                await module.refresh();
            } catch (e) {
                this.reportError(e, `${module.name}.refresh`);
            }
        }
    }

    /**
     * Dispatch a command written to one of our states.
     *
     * @param id state id relative to the adapter namespace, e.g. `audio.volume`
     * @returns true when a module claimed and executed the write
     */
    public async write(id: string, value: ioBroker.StateValue): Promise<boolean> {
        if (!this.ready) {
            throw new BraviaError('Display is not initialised yet', 'retryable');
        }
        const separator = id.indexOf('.');
        if (separator === -1) {
            return false;
        }
        const root = id.slice(0, separator);
        const path = id.slice(separator + 1);
        const handler = this.writeHandlers.get(root);
        if (!handler) {
            return false;
        }
        return handler(path, value);
    }

    /**
     * Route an SSIP push notification to whichever module owns it.
     *
     */
    public async handleNotify(message: SsipMessage): Promise<void> {
        for (const module of this.modules) {
            if (!module.onNotify) {
                continue;
            }
            try {
                if (await module.onNotify(message)) {
                    return;
                }
            } catch (e) {
                this.reportError(e, `${module.name}.onNotify`);
            }
        }
        this.store.log.debug(`Unhandled SSIP notification ${message.command} ${message.parameter}`);
    }

    private reportError(error: unknown, context: string): void {
        const braviaError = error instanceof BraviaError ? error : null;
        const message = error instanceof Error ? error.message : String(error);

        // A display in standby refuses most calls by design; log that at debug so a powered-down
        // screen does not fill the log with warnings.
        if (braviaError?.kind === 'displayOff') {
            this.store.log.debug(`${context}: ${message}`);
            return;
        }
        if (braviaError?.kind === 'unsupported') {
            this.store.log.debug(`${context}: not supported by this display (${message})`);
            return;
        }

        this.store.log.warn(`${context}: ${message}`);
        void this.store.setAck('info.lastError', `${context}: ${message}`);
    }

    public get isReady(): boolean {
        return this.ready;
    }

    /** Every root channel this device routes writes for. Used by the coverage test. */
    public get writableRoots(): string[] {
        return [...this.writeHandlers.keys()];
    }
}
