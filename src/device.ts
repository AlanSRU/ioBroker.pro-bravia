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
import type { TimerApi } from './lib/timers';
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
    /** Framework timers, so the SSIP reconnect backoff dies with the instance. */
    timers?: TimerApi;
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
    private stopped = false;
    /**
     * Discovery only returns anything meaningful while the panel is on: in standby the display
     * answers `getPowerStatus` normally but refuses audio, video, input and app queries with
     * `40005`. When that happens the tree is a stub, and it must be rebuilt once the display wakes.
     */
    private discoveryPending = false;
    private sawDisplayOff = false;
    private probeFailing = false;
    /**
     * Contexts already reported at warn level. A display that is unplugged fails ~9 calls per
     * poll; without this the log fills with identical lines indefinitely.
     */
    private readonly reportedContexts = new Set<string>();

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

        this.ssip = options.useSsip
            ? new SsipClient({ host: options.host, port: options.ssipPort, timers: options.timers })
            : null;

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
            timers: this.options.timers,
            reportError: (error, context) => this.reportError(error, context),
        };
    }

    /**
     * Confirm the display is actually answering.
     *
     * The module loops below deliberately swallow per-feature failures so one unsupported
     * method cannot abort discovery — which means they can never tell the caller the display
     * is unreachable. This single unguarded call is the liveness signal `info.connection`
     * is driven from, and it is also what surfaces a wrong pre-shared key as an auth error.
     */
    public async probe(): Promise<boolean> {
        let status: string;
        try {
            const result = await this.rest.callFirst<{ status?: string }>('system', 'getPowerStatus');
            status = result.status ?? '';
        } catch (e) {
            this.probeFailing = true;
            throw e;
        }

        // Only a genuine unreachable -> reachable transition makes old failures newsworthy again.
        // Clearing on every successful probe would reset the set before it was ever consulted,
        // leaving the de-duplication inert and the warning repeating on every poll.
        if (this.probeFailing) {
            this.probeFailing = false;
            this.reportedContexts.clear();
        }
        return status === 'active';
    }

    /** Stop all further work. Called from `onUnload` before the transports are torn down. */
    public stop(): void {
        this.stopped = true;
    }

    /**
     * Discover what the display supports and build the state tree from it.
     *
     * Called once the display is reachable. Safe to call again after a reconnection: object
     * creation is idempotent.
     */
    public async initialise(): Promise<void> {
        // Must come first: Capabilities.discover() falls back to "assume everything supported"
        // when the display does not answer, so on its own it hides an unreachable display.
        const active = await this.probe();
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

        await this.runModuleInit();
        // A display in standby yields an empty tree without failing, so mark it for a rebuild.
        this.discoveryPending = !active || this.sawDisplayOff;
        if (this.discoveryPending) {
            this.store.log.info(
                'The display is in standby, so it could not report its capabilities yet; ' +
                    'discovery will complete automatically once it is switched on.',
            );
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

    /** Create objects for every module. Idempotent, so it can be re-run when the display wakes. */
    private async runModuleInit(): Promise<void> {
        this.sawDisplayOff = false;
        for (const module of this.modules) {
            // Re-checked every iteration: discovery can run for a long time against a slow
            // display, and a Save in admin restarts the instance underneath it.
            if (this.stopped) {
                return;
            }
            try {
                await module.init();
            } catch (e) {
                this.reportError(e, `${module.name}.init`);
            }
        }
    }

    /** Re-read every value the display exposes. */
    public async refresh(): Promise<void> {
        if (!this.ready || this.stopped) {
            return;
        }
        // Rejects when the display is unreachable, so the caller can act on it.
        const active = await this.probe();

        // Finish the discovery that standby prevented, before any module writes values that
        // would otherwise land on objects that were never created.
        if (active && this.discoveryPending) {
            this.store.log.info('Display is on; completing the capability discovery it refused in standby');
            await this.runModuleInit();
            this.discoveryPending = this.sawDisplayOff;
        }

        for (const module of this.modules) {
            if (this.stopped) {
                return;
            }
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
            this.sawDisplayOff = true;
            this.store.log.debug(`${context}: ${message}`);
            return;
        }
        if (braviaError?.kind === 'unsupported') {
            this.store.log.debug(`${context}: not supported by this display (${message})`);
            return;
        }

        if (this.stopped) {
            return;
        }

        // Warn once per context until the display answers again; repeats go to debug.
        if (this.reportedContexts.has(context)) {
            this.store.log.debug(`${context}: ${message}`);
            return;
        }
        this.reportedContexts.add(context);
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
