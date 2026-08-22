import { sanitiseId } from '../discovery/state-mapper';
import { pruneChildren } from '../lib/state-store';
import { SSIP_COMMANDS, decodeInputParam, type SsipInputType, type SsipMessage } from '../transport/ssip-protocol';
import type { DeviceContext, FeatureModule } from './types';

/**
 * External inputs.
 *
 * The input list is read from the display (`getCurrentExternalInputsStatus`), which reports the
 * user-assigned label and whether anything is actually plugged in — both useful in a venue where
 * an operator needs to know a source is live before switching to it.
 */

interface ExternalInput {
    uri?: string;
    title?: string;
    label?: string;
    connection?: boolean;
    icon?: string;
    status?: string;
}

/** SSIP reports inputs numerically; the REST API uses URIs. Bridge the two. */
const SSIP_TYPE_TO_SCHEME: Record<SsipInputType, string> = {
    hdmi: 'hdmi',
    composite: 'composite',
    component: 'component',
    screenMirroring: 'widi',
};

export class AvContentModule implements FeatureModule {
    public readonly root = 'input';
    public readonly name = 'avContent';

    private inputs: ExternalInput[] = [];
    /** state id segment -> input uri */
    private readonly idToUri = new Map<string, string>();

    public constructor(private readonly ctx: DeviceContext) {}

    public async init(): Promise<void> {
        const { store, capabilities } = this.ctx;

        if (!capabilities.hasService('avContent')) {
            return;
        }

        const canSelect = capabilities.supports('avContent', 'setPlayContent');

        await store.ensureChannel('input', 'Inputs');
        await store.ensureState('input.current', {
            name: 'Current input URI',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await store.ensureState('input.currentTitle', {
            name: 'Current input name',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await store.ensureState('input.list', {
            name: 'Available inputs (JSON)',
            type: 'string',
            role: 'json',
            read: true,
            write: false,
        });

        this.inputs = await this.readInputs();

        await store.ensureState('input.select', {
            name: 'Select input',
            type: 'string',
            role: 'text',
            read: true,
            write: canSelect,
            states: Object.fromEntries(
                this.inputs.filter(input => input.uri).map(input => [input.uri!, this.displayName(input)]),
            ),
        });

        if (this.inputs.length > 0) {
            await store.ensureChannel('input.sources', 'Input sources');
            for (const input of this.inputs) {
                if (!input.uri) {
                    continue;
                }
                const id = this.idFor(input);
                this.idToUri.set(id, input.uri);
                await store.ensureChannel(`input.sources.${id}`, this.displayName(input));
                await store.ensureState(`input.sources.${id}.uri`, {
                    name: 'URI',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                });
                await store.ensureState(`input.sources.${id}.title`, {
                    name: 'Title',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                });
                await store.ensureState(`input.sources.${id}.label`, {
                    name: 'User label',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                });
                await store.ensureState(`input.sources.${id}.connected`, {
                    name: 'Source connected',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                });
                if (canSelect) {
                    await store.ensureState(`input.sources.${id}.select`, {
                        name: `Switch to ${this.displayName(input)}`,
                        type: 'boolean',
                        role: 'button',
                        read: false,
                        write: true,
                    });
                }
            }
            await pruneChildren(store, 'input.sources', this.idToUri.keys());
        }

        await this.applyInputs();
    }

    private idFor(input: ExternalInput): string {
        // extInput:hdmi?port=2 -> hdmi2, which is far more readable than the raw URI.
        const match = /^extInput:([a-zA-Z0-9_]+)(?:\?port=(\d+))?$/.exec(input.uri ?? '');
        if (match) {
            return sanitiseId(match[2] ? `${match[1]}${match[2]}` : match[1]);
        }
        return sanitiseId(input.uri ?? input.title ?? 'input');
    }

    private displayName(input: ExternalInput): string {
        return input.label || input.title || input.uri || 'Input';
    }

    private async readInputs(): Promise<ExternalInput[]> {
        const { rest, capabilities } = this.ctx;
        if (!capabilities.supports('avContent', 'getCurrentExternalInputsStatus')) {
            return [];
        }
        const version =
            capabilities.pickVersion('avContent', 'getCurrentExternalInputsStatus', ['1.1', '1.0']) ?? '1.0';
        try {
            const result = await rest.call<ExternalInput[][]>(
                'avContent',
                'getCurrentExternalInputsStatus',
                [],
                version,
            );
            return Array.isArray(result[0]) ? result[0] : [];
        } catch (e) {
            this.ctx.reportError(e, 'avContent.getCurrentExternalInputsStatus');
            return [];
        }
    }

    private async applyInputs(): Promise<void> {
        const { store } = this.ctx;
        await store.setAck('input.list', JSON.stringify(this.inputs));
        for (const input of this.inputs) {
            if (!input.uri) {
                continue;
            }
            const id = this.idFor(input);
            // Only ids this module created have objects. A display that was in standby at
            // startup reports its inputs for the first time here, before the channels exist.
            if (!this.idToUri.has(id)) {
                continue;
            }
            await store.setAck(`input.sources.${id}.uri`, input.uri);
            await store.setAck(`input.sources.${id}.title`, input.title ?? '');
            await store.setAck(`input.sources.${id}.label`, input.label ?? '');
            await store.setAck(`input.sources.${id}.connected`, input.connection === true);
        }
    }

    public async refresh(): Promise<void> {
        const { rest, store, capabilities } = this.ctx;

        if (!capabilities.hasService('avContent')) {
            return;
        }

        // Connection status changes as sources are plugged and unplugged.
        const inputs = await this.readInputs();
        if (inputs.length > 0) {
            this.inputs = inputs;
            await this.applyInputs();
        }

        if (capabilities.supports('avContent', 'getPlayingContentInfo')) {
            try {
                const playing = await rest.callFirst<{
                    uri?: string;
                    title?: string;
                }>('avContent', 'getPlayingContentInfo');
                await store.setAck('input.current', playing.uri ?? '');
                await store.setAck('input.currentTitle', playing.title ?? '');
                if (playing.uri) {
                    await store.setAck('input.select', playing.uri);
                }
            } catch (e) {
                // A display in standby answers 40005 here; that is expected, not a fault.
                this.ctx.reportError(e, 'avContent.getPlayingContentInfo');
            }
        }
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        if (path === 'select') {
            await this.selectUri(String(value));
            return true;
        }

        const button = /^sources\.([^.]+)\.select$/.exec(path);
        if (button) {
            const uri = this.idToUri.get(button[1]);
            if (!uri) {
                return false;
            }
            await this.selectUri(uri);
            return true;
        }

        return false;
    }

    private async selectUri(uri: string): Promise<void> {
        await this.ctx.rest.call('avContent', 'setPlayContent', [{ uri }]);
        await this.ctx.store.setAck('input.select', uri);
        await this.ctx.store.setAck('input.current', uri);
        const input = this.inputs.find(candidate => candidate.uri === uri);
        if (input) {
            await this.ctx.store.setAck('input.currentTitle', input.title ?? '');
        }
    }

    public async onNotify(message: SsipMessage): Promise<boolean> {
        if (message.command !== SSIP_COMMANDS.input) {
            return false;
        }
        const decoded = decodeInputParam(message.parameter);
        if (!decoded) {
            return true;
        }
        const uri = `extInput:${SSIP_TYPE_TO_SCHEME[decoded.type]}?port=${decoded.port}`;
        await this.ctx.store.setAck('input.current', uri);
        await this.ctx.store.setAck('input.select', uri);
        const input = this.inputs.find(candidate => candidate.uri === uri);
        if (input) {
            await this.ctx.store.setAck('input.currentTitle', input.title ?? '');
        }
        return true;
    }
}
