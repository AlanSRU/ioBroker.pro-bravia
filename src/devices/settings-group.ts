import { describeSettings, type SettingDescriptor, type SettingEntry } from '../discovery/state-mapper';
import { BraviaError } from '../lib/errors';
import type { BraviaService } from '../transport/rest-client';
import type { DeviceContext } from './types';

/**
 * A discovered `getXxxSettings` / `setXxxSettings` pair.
 *
 * Picture quality, speaker settings and sound settings all share this shape: ask the display for
 * its targets and candidate values, generate one state per target, then write back through the
 * paired setter. Nothing about the target list is hardcoded.
 */

export interface SettingsGroupOptions {
    /** Channel the states live under, e.g. `video.picture`. */
    root: string;
    label: string;
    service: BraviaService;
    getMethod: string;
    setMethod: string;
    /** Versions to try for the getter, most preferred first. */
    getVersions: string[];
    setVersions: string[];
    /**
     * Targets that must be sent alone in their own request. Sony documents that batching
     * `hdmiSignalFormat` with other targets can fail depending on the current signal.
     */
    isolatedTargets?: string[];
    /** Fallback targets to expose when the display has a setter but no matching getter. */
    fallbackEntries?: SettingEntry[];
}

export class SettingsGroup {
    private descriptors = new Map<string, SettingDescriptor>();
    private getVersion?: string;
    private setVersion?: string;
    private readonly isolated: Set<string>;

    public constructor(
        private readonly ctx: DeviceContext,
        private readonly options: SettingsGroupOptions,
    ) {
        this.isolated = new Set(options.isolatedTargets ?? []);
    }

    public get root(): string {
        return this.options.root;
    }

    public get targets(): string[] {
        return [...this.descriptors.keys()];
    }

    /** Discover the targets and create one state per target. */
    public async init(): Promise<void> {
        const { capabilities, store } = this.ctx;
        const { service, getMethod, setMethod, getVersions, setVersions, root, label } = this.options;

        this.getVersion = capabilities.pickVersion(service, getMethod, getVersions);
        this.setVersion = capabilities.pickVersion(service, setMethod, setVersions);

        const writable = this.setVersion !== undefined;
        let entries: SettingEntry[] = [];

        if (this.getVersion !== undefined) {
            try {
                entries = await this.readAll();
            } catch (e) {
                this.ctx.reportError(e, `${service}.${getMethod}`);
            }
        }

        // Some displays offer the setter without a documented getter (audio sound settings).
        if (entries.length === 0 && writable && this.options.fallbackEntries) {
            entries = this.options.fallbackEntries;
            store.log.debug(`${label}: display did not report targets via ${getMethod}; using documented defaults`);
        }

        if (entries.length === 0) {
            store.log.debug(`${label}: no settings targets available on this display`);
            return;
        }

        await store.ensureChannel(root, label);
        for (const descriptor of describeSettings(entries, writable)) {
            this.descriptors.set(descriptor.target, descriptor);
            await store.ensureState(`${root}.${descriptor.id}`, descriptor.common);
        }

        store.log.debug(`${label}: discovered ${this.descriptors.size} target(s): ${this.targets.join(', ')}`);
        await this.applyEntries(entries);
    }

    private async readAll(): Promise<SettingEntry[]> {
        const { rest } = this.ctx;
        const { service, getMethod } = this.options;
        const result = await rest.call<SettingEntry[][] | SettingEntry[]>(
            service,
            getMethod,
            [{ target: '' }],
            this.getVersion ?? '1.0',
        );
        // The getters wrap their list one level deeper than most methods.
        const first = (result as unknown[])[0];
        return Array.isArray(first) ? (first as SettingEntry[]) : (result as SettingEntry[]);
    }

    public async refresh(): Promise<void> {
        if (this.descriptors.size === 0 || this.getVersion === undefined) {
            return;
        }
        try {
            await this.applyEntries(await this.readAll());
        } catch (e) {
            this.ctx.reportError(e, `${this.options.service}.${this.options.getMethod}`);
        }
    }

    private async applyEntries(entries: SettingEntry[]): Promise<void> {
        for (const entry of entries) {
            const descriptor = this.descriptors.get(entry?.target);
            if (!descriptor || typeof entry.currentValue !== 'string') {
                continue;
            }
            await this.ctx.store.setAck(
                `${this.options.root}.${descriptor.id}`,
                descriptor.fromDevice(entry.currentValue),
            );
        }
    }

    /**
     * Handle a write to `<root>.<id>`. Returns false when the id is not one of ours.
     *
     */
    public async write(id: string, value: ioBroker.StateValue): Promise<boolean> {
        const descriptor = [...this.descriptors.values()].find(candidate => candidate.id === id);
        if (!descriptor) {
            return false;
        }
        if (this.setVersion === undefined) {
            throw new BraviaError(
                `${this.options.label}: this display does not support ${this.options.setMethod}`,
                'unsupported',
            );
        }

        const payload = { target: descriptor.target, value: descriptor.toDevice(value) };
        await this.ctx.rest.call(
            this.options.service,
            this.options.setMethod,
            [{ settings: [payload] }],
            this.setVersion,
        );
        await this.ctx.store.setAck(`${this.options.root}.${descriptor.id}`, value);
        return true;
    }

    /**
     * True when this target must not be batched with others. Consulted by callers that batch.
     *
     */
    public isIsolated(target: string): boolean {
        return this.isolated.has(target);
    }
}
