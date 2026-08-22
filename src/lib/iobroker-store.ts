import type * as utils from '@iobroker/adapter-core';

import { type Logger, type StateStore, parentIds } from './state-store';

/**
 * {@link StateStore} backed by a live ioBroker adapter.
 *
 * The one piece of real logic here is parent-channel creation: `ensureState('audio.outputs.speaker.volume')`
 * also creates `audio`, `audio.outputs` and `audio.outputs.speaker`. ioBroker itself is happy with
 * orphan states, but the repository object checker rejects an object dump with missing
 * intermediate objects (E3009), so this is done centrally rather than remembered at each call site.
 */
export class IoBrokerStateStore implements StateStore {
    /** Ids already created in this process, so repeat calls cost nothing. */
    private readonly created = new Set<string>();

    public constructor(private readonly adapter: utils.AdapterInstance) {}

    public get log(): Logger {
        return {
            debug: message => this.adapter.log.debug(message),
            info: message => this.adapter.log.info(message),
            warn: message => this.adapter.log.warn(message),
            error: message => this.adapter.log.error(message),
        };
    }

    private async ensureParents(id: string): Promise<void> {
        for (const parent of parentIds(id)) {
            if (this.created.has(parent)) {
                continue;
            }
            await this.adapter.setObjectNotExistsAsync(parent, {
                type: 'channel',
                common: { name: parent.split('.').pop()! },
                native: {},
            });
            this.created.add(parent);
        }
    }

    public async ensureChannel(id: string, name: string): Promise<void> {
        await this.ensureParents(id);
        if (this.created.has(id)) {
            return;
        }
        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'channel',
            common: { name },
            native: {},
        });
        this.created.add(id);
    }

    public async ensureState(id: string, common: ioBroker.StateCommon): Promise<void> {
        await this.ensureParents(id);
        await this.adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        // setObjectNotExistsAsync never updates an existing object, so a display whose candidate
        // list changed (new firmware, different input) would keep a stale range or state list.
        await this.adapter.extendObject(id, { type: 'state', common });
        this.created.add(id);
    }

    public async setAck(id: string, value: ioBroker.StateValue): Promise<void> {
        await this.adapter.setState(id, { val: value, ack: true });
    }

    public async getValue(id: string): Promise<ioBroker.StateValue | undefined> {
        const state = await this.adapter.getStateAsync(id);
        return state?.val ?? undefined;
    }

    public async deleteObject(id: string): Promise<void> {
        await this.adapter.delObjectAsync(id, { recursive: true });
        for (const key of [...this.created]) {
            if (key === id || key.startsWith(`${id}.`)) {
                this.created.delete(key);
            }
        }
    }

    public async childIds(parent: string): Promise<string[]> {
        const prefix = `${this.adapter.namespace}.${parent}.`;
        const objects = await this.adapter.getAdapterObjectsAsync();
        const children = new Set<string>();
        for (const id of Object.keys(objects)) {
            if (id.startsWith(prefix)) {
                children.add(id.slice(prefix.length).split('.')[0]);
            }
        }
        return [...children];
    }
}
