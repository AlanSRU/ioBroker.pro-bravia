/**
 * The only surface the device modules are allowed to touch.
 *
 * Keeping them off the ioBroker adapter object directly means every module is unit-testable
 * against an in-memory store, and the mapping from device concepts to ioBroker objects lives
 * in exactly one place.
 */

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface StateStore {
    /**
     * Create a state, and every parent channel on the way to it.
     *
     * Parent creation is not optional: ioBroker tolerates orphan states at runtime, but the
     * repository object checker rejects a dump with missing intermediate objects (E3009).
     */
    ensureState(id: string, common: ioBroker.StateCommon): Promise<void>;
    /** Create a channel (and its parents) without a state underneath. */
    ensureChannel(id: string, name: string): Promise<void>;
    /** Report a value read from the device (always acknowledged). */
    setAck(id: string, value: ioBroker.StateValue): Promise<void>;
    getValue(id: string): Promise<ioBroker.StateValue | undefined>;
    /** Remove an object subtree, e.g. when discovery no longer reports it. */
    deleteObject(id: string): Promise<void>;
    /** Ids of existing objects directly beneath `parent`, without the namespace prefix. */
    childIds(parent: string): Promise<string[]>;
    readonly log: Logger;
}

/**
 * Fill in `common.def` when the caller has not set one.
 *
 * Every state is expected to declare a default; without one a freshly created state reads as
 * `null` until the display is first polled, which scripts and VIS widgets bind to as a real value.
 */
export function withStateDefaults(common: ioBroker.StateCommon): ioBroker.StateCommon {
    if (common.def !== undefined) {
        return common;
    }
    let def: ioBroker.StateValue;
    if (common.type === 'boolean') {
        def = false;
    } else if (common.type === 'number') {
        // Stay inside the declared range, or a discovered level would default out of bounds.
        def = typeof common.min === 'number' ? common.min : 0;
    } else {
        def = '';
    }
    return { ...common, def };
}

/**
 * Split `a.b.c` into the parent channel ids `a` and `a.b`.
 *
 */
export function parentIds(id: string): string[] {
    const segments = id.split('.');
    const parents: string[] = [];
    for (let i = 1; i < segments.length; i++) {
        parents.push(segments.slice(0, i).join('.'));
    }
    return parents;
}

/**
 * In-memory implementation used by the unit tests.
 *
 * The methods are synchronous internally but keep the Promise-returning signature of
 * {@link StateStore}, so tests exercise the same call shape the real adapter uses.
 */
/* eslint-disable @typescript-eslint/require-await */
export class MemoryStateStore implements StateStore {
    public readonly objects = new Map<string, { type: 'state' | 'channel'; common: Record<string, unknown> }>();
    public readonly values = new Map<string, { value: ioBroker.StateValue; ack: boolean }>();
    public readonly logs: string[] = [];

    public readonly log: Logger = {
        debug: message => this.logs.push(`debug: ${message}`),
        info: message => this.logs.push(`info: ${message}`),
        warn: message => this.logs.push(`warn: ${message}`),
        error: message => this.logs.push(`error: ${message}`),
    };

    public async ensureChannel(id: string, name: string): Promise<void> {
        for (const parent of parentIds(id)) {
            if (!this.objects.has(parent)) {
                this.objects.set(parent, { type: 'channel', common: { name: parent.split('.').pop()! } });
            }
        }
        if (!this.objects.has(id)) {
            this.objects.set(id, { type: 'channel', common: { name } });
        }
    }

    public async ensureState(id: string, common: ioBroker.StateCommon): Promise<void> {
        for (const parent of parentIds(id)) {
            if (!this.objects.has(parent)) {
                this.objects.set(parent, { type: 'channel', common: { name: parent.split('.').pop()! } });
            }
        }
        this.objects.set(id, {
            type: 'state',
            common: withStateDefaults(common) as unknown as Record<string, unknown>,
        });
    }

    public async setAck(id: string, value: ioBroker.StateValue): Promise<void> {
        this.values.set(id, { value, ack: true });
    }

    public async getValue(id: string): Promise<ioBroker.StateValue | undefined> {
        return this.values.get(id)?.value;
    }

    public async deleteObject(id: string): Promise<void> {
        for (const key of [...this.objects.keys()]) {
            if (key === id || key.startsWith(`${id}.`)) {
                this.objects.delete(key);
                this.values.delete(key);
            }
        }
    }

    public async childIds(parent: string): Promise<string[]> {
        const prefix = `${parent}.`;
        const children = new Set<string>();
        for (const key of this.objects.keys()) {
            if (key.startsWith(prefix)) {
                children.add(key.slice(prefix.length).split('.')[0]);
            }
        }
        return [...children];
    }

    /** Test helper: every state id that was created writable. */
    public writableStates(): string[] {
        return [...this.objects.entries()]
            .filter(([, object]) => object.type === 'state' && object.common.write === true)
            .map(([id]) => id);
    }
}
