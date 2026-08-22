import { sanitiseId } from '../discovery/state-mapper';
import { BraviaError } from '../lib/errors';
import { SSIP_COMMANDS, SSIP_IR_CODES, encodeNumericParam } from '../transport/ssip-protocol';
import type { DeviceContext, FeatureModule } from './types';

/**
 * Remote-control key emulation.
 *
 * Two independent routes exist and the adapter uses whichever is available:
 *  - IRCC-IP over SOAP, whose key table is read from the display itself
 *    (`system.getRemoteControllerInfo`), so it matches the model exactly
 *  - Simple IP Control's `IRCC` command, which takes a fixed numeric code table
 *
 * IRCC-IP is preferred because its key set is discovered; SSIP is the fallback when IRCC-IP is
 * disabled, and covers the common keys.
 */

interface RemoteKey {
    name?: string;
    value?: string;
}

export class RemoteModule implements FeatureModule {
    public readonly root = 'remote';
    public readonly name = 'remote';

    /** state id segment -> base64 IRCC code */
    private readonly irccCodes = new Map<string, string>();
    /** state id segment -> SSIP numeric IR code */
    private readonly ssipCodes = new Map<string, number>();

    public constructor(private readonly ctx: DeviceContext) {}

    public async init(): Promise<void> {
        const { store, ircc, ssip } = this.ctx;

        if (!ircc && !ssip) {
            return;
        }

        await store.ensureChannel('remote', 'Remote control');

        if (ircc) {
            for (const key of await this.readRemoteKeys()) {
                if (!key.name || !key.value) {
                    continue;
                }
                this.irccCodes.set(sanitiseId(key.name), key.value);
            }
            await store.ensureState('remote.sendCode', {
                name: 'Send raw IRCC code (base64)',
                type: 'string',
                role: 'text',
                read: false,
                write: true,
            });
        }

        if (ssip) {
            for (const [name, code] of Object.entries(SSIP_IR_CODES)) {
                this.ssipCodes.set(sanitiseId(name), code);
            }
        }

        // Union of both tables, so a key is exposed if either transport can send it.
        const keys = new Set([...this.irccCodes.keys(), ...this.ssipCodes.keys()]);
        if (keys.size === 0) {
            store.log.warn('No remote control keys could be discovered for this display');
            return;
        }

        await store.ensureChannel('remote.keys', 'Remote keys');
        for (const key of [...keys].sort()) {
            await store.ensureState(`remote.keys.${key}`, {
                name: key,
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
        }
        store.log.debug(`Remote control: ${keys.size} key(s) available`);
    }

    private async readRemoteKeys(): Promise<RemoteKey[]> {
        const { rest, capabilities } = this.ctx;
        if (!capabilities.supports('system', 'getRemoteControllerInfo')) {
            return [];
        }
        try {
            // The result is a two-element array: [ {bundled,type}, [ {name,value}, ... ] ].
            const result = await rest.call<unknown[]>('system', 'getRemoteControllerInfo');
            const keys = result.find(Array.isArray) as RemoteKey[] | undefined;
            return keys ?? [];
        } catch (e) {
            this.ctx.reportError(e, 'system.getRemoteControllerInfo');
            return [];
        }
    }

    public async refresh(): Promise<void> {
        // Buttons are write-only; there is nothing to read back.
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        if (path === 'sendCode') {
            const code = String(value).trim();
            if (code === '') {
                return true;
            }
            await this.sendIrcc(code);
            return true;
        }

        const key = /^keys\.(.+)$/.exec(path);
        if (!key) {
            return false;
        }
        await this.sendKey(key[1]);
        return true;
    }

    private async sendKey(key: string): Promise<void> {
        const code = this.irccCodes.get(key);
        if (code && this.ctx.ircc) {
            await this.sendIrcc(code);
            return;
        }

        const numeric = this.ssipCodes.get(key);
        if (numeric !== undefined && this.ctx.ssip) {
            await this.ctx.ssip.controlChecked(SSIP_COMMANDS.ircc, encodeNumericParam(numeric));
            return;
        }

        throw new BraviaError(`Remote key "${key}" cannot be sent by any enabled transport`, 'unsupported');
    }

    private async sendIrcc(code: string): Promise<void> {
        if (!this.ctx.ircc) {
            throw new BraviaError('IRCC-IP is disabled in the instance configuration', 'unsupported');
        }
        await this.ctx.ircc.send(code);
    }
}
