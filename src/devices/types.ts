import type { Capabilities } from '../discovery/capabilities';
import type { StateStore } from '../lib/state-store';
import type { TimerApi } from '../lib/timers';
import type { BraviaIrccClient } from '../transport/ircc-client';
import type { BraviaRestClient } from '../transport/rest-client';
import type { SsipClient } from '../transport/ssip-client';
import type { SsipMessage } from '../transport/ssip-protocol';

export interface DeviceConfig {
    host: string;
    /** Subnet broadcast address for Wake-on-LAN; discovered from the display when possible. */
    broadcastAddress?: string;
    macAddress?: string;
}

export interface DeviceContext {
    rest: BraviaRestClient;
    /** Null when Simple IP Control is disabled in the instance configuration. */
    ssip: SsipClient | null;
    /** Null when IRCC-IP is disabled in the instance configuration. */
    ircc: BraviaIrccClient | null;
    capabilities: Capabilities;
    store: StateStore;
    config: DeviceConfig;
    /** Framework timers, so nothing a module schedules can outlive the instance. */
    timers?: TimerApi;
    /** Record the most recent failure for `info.lastError`. */
    reportError(error: unknown, context: string): void;
}

/**
 * One functional area of the display.
 *
 * `init` creates objects (once, at startup), `refresh` re-reads values from the display, and
 * `write` handles a command written to one of this module's states. A module must handle every
 * writable state it creates — {@link FeatureModule.write} returning false for an id under its
 * own root is a bug, and the test suite asserts against it.
 */
export interface FeatureModule {
    /** Root channel this module owns, e.g. `audio`. States live beneath it. */
    readonly root: string;
    /** Human-readable module name for logs. */
    readonly name: string;
    init(): Promise<void>;
    refresh(): Promise<void>;
    /**
     * @param path state id relative to this module's root, e.g. `speaker.tvPosition`
     * @returns true if the write was recognised and dispatched
     */
    write(path: string, value: ioBroker.StateValue): Promise<boolean>;
    /** Handle an SSIP push notification. Return true if it was consumed. */
    onNotify?(message: SsipMessage): Promise<boolean>;
}
