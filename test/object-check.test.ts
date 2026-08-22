import { BraviaDevice } from '../src/device';
import { MemoryStateStore, parentIds } from '../src/lib/state-store';
import { MockBraviaDisplay } from './mock-bravia-server';

/**
 * Offline equivalent of the ioBroker repository object checker.
 *
 * The real checker runs against a live object dump at submission time, which is far too late to
 * discover that a role contradicts its read/write flags. These rules are copied verbatim from
 * `lib/config_StateRoles.js` in ioBroker.repochecker (STATE_ROLE_RULES); the test also asserts
 * that every role the adapter uses is present here, so introducing a new role forces this table
 * to be updated deliberately rather than silently escaping validation.
 */
interface RoleRule {
    types: string[];
    read?: boolean;
    write?: boolean;
}

const STATE_ROLE_RULES: Record<string, RoleRule> = {
    button: { types: ['boolean'], read: false, write: true },
    indicator: { types: ['boolean'], read: true, write: false },
    'indicator.connected': { types: ['boolean'], read: true, write: false },
    'info.ip': { types: ['string'], read: true, write: false },
    'info.mac': { types: ['string'], read: true, write: false },
    'info.name': { types: ['string'], read: true },
    'info.serial': { types: ['string'], read: true, write: false },
    json: { types: ['string', 'json'] },
    level: { types: ['number'], read: true, write: true },
    'level.volume': { types: ['number'], read: true, write: true },
    switch: { types: ['boolean'], read: true, write: true },
    'switch.power': { types: ['boolean'], read: true, write: true },
    text: { types: ['string'] },
    value: { types: ['number'], read: true, write: false },
};

const buildStore = async (
    mock: MockBraviaDisplay,
): Promise<{ store: MemoryStateStore; close: () => Promise<void> }> => {
    await mock.start();
    const store = new MemoryStateStore();
    const device = new BraviaDevice(
        {
            host: '127.0.0.1',
            psk: '1234',
            httpPort: mock.httpPort,
            useSsip: true,
            ssipPort: mock.ssipPort,
            useIrcc: true,
        },
        store,
    );
    device.ssip!.connect();
    await new Promise<void>(resolve => device.ssip!.once('connect', () => resolve()));
    await device.initialise();
    return {
        store,
        close: async () => {
            device.ssip?.close();
            await mock.stop();
        },
    };
};

describe('created objects satisfy the repository object checker rules', () => {
    // Several capability profiles, so states that only exist on some models are covered too.
    const profiles: [string, () => MockBraviaDisplay][] = [
        ['a fully featured display', () => new MockBraviaDisplay()],
        [
            'a BZ-series display without videoScreen',
            () => new MockBraviaDisplay({ services: ['guide', 'system', 'audio', 'avContent', 'video', 'appControl'] }),
        ],
        [
            'a display with read-only settings',
            () =>
                new MockBraviaDisplay({
                    unsupportedMethods: ['setWolMode', 'setLEDIndicatorStatus', 'setScreenRotation', 'requestReboot'],
                }),
        ],
    ];

    for (const [label, factory] of profiles) {
        describe(label, () => {
            let store: MemoryStateStore;
            let close: () => Promise<void>;

            beforeAll(async () => {
                ({ store, close } = await buildStore(factory()));
            });

            afterAll(async () => {
                await close();
            });

            it('uses only roles covered by the vendored rule table', () => {
                const unknown = new Set<string>();
                for (const [, object] of store.objects) {
                    if (object.type !== 'state') {
                        continue;
                    }
                    const role = object.common.role as string;
                    if (!(role in STATE_ROLE_RULES)) {
                        unknown.add(role);
                    }
                }
                expect([...unknown]).toEqual([]);
            });

            it("never contradicts a role's type, read or write constraint", () => {
                const violations: string[] = [];
                for (const [id, object] of store.objects) {
                    if (object.type !== 'state') {
                        continue;
                    }
                    const common = object.common as { role: string; type: string; read: boolean; write: boolean };
                    const rule = STATE_ROLE_RULES[common.role];
                    if (!rule) {
                        continue;
                    }
                    if (!rule.types.includes(common.type)) {
                        violations.push(
                            `${id}: role "${common.role}" requires type ${rule.types.join('|')}, got ${common.type}`,
                        );
                    }
                    if (rule.read !== undefined && common.read !== rule.read) {
                        violations.push(`${id}: role "${common.role}" requires read=${rule.read}, got ${common.read}`);
                    }
                    if (rule.write !== undefined && common.write !== rule.write) {
                        violations.push(
                            `${id}: role "${common.role}" requires write=${rule.write}, got ${common.write}`,
                        );
                    }
                }
                expect(violations).toEqual([]);
            });

            it('declares read and write explicitly on every state', () => {
                const incomplete: string[] = [];
                for (const [id, object] of store.objects) {
                    if (object.type !== 'state') {
                        continue;
                    }
                    const common = object.common;
                    if (typeof common.read !== 'boolean' || typeof common.write !== 'boolean') {
                        incomplete.push(id);
                    }
                    if (typeof common.name !== 'string' || common.name === '') {
                        incomplete.push(`${id} (no name)`);
                    }
                }
                expect(incomplete).toEqual([]);
            });

            it('creates every intermediate parent object (repochecker E3009)', () => {
                const missing: string[] = [];
                for (const id of store.objects.keys()) {
                    for (const parent of parentIds(id)) {
                        if (!store.objects.has(parent)) {
                            missing.push(`${id} -> missing ${parent}`);
                        }
                    }
                }
                expect(missing).toEqual([]);
            });

            it('uses only characters ioBroker permits in object ids', () => {
                const invalid = [...store.objects.keys()].filter(id => /[\][*,;'"`<>\\?\s]/.test(id));
                expect(invalid).toEqual([]);
            });

            it('gives every numeric level state a usable range', () => {
                const unbounded: string[] = [];
                for (const [id, object] of store.objects) {
                    const common = object.common as { role?: string; min?: number; max?: number };
                    if (object.type === 'state' && common.role?.startsWith('level')) {
                        if (typeof common.min !== 'number' || typeof common.max !== 'number') {
                            unbounded.push(id);
                        } else if (common.min >= common.max) {
                            unbounded.push(`${id} (min ${common.min} >= max ${common.max})`);
                        }
                    }
                }
                expect(unbounded).toEqual([]);
            });
        });
    }
});
