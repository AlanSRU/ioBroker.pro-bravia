import { sanitiseId } from '../discovery/state-mapper';
import { SSIP_COMMANDS, parseNumericAnswer, type SsipMessage } from '../transport/ssip-protocol';
import { SettingsGroup } from './settings-group';
import type { DeviceContext, FeatureModule } from './types';

/**
 * Volume, mute and the two discovered audio settings groups.
 *
 * `getVolumeInformation` reports one entry per output (speaker, headphone, ...) with its own
 * range, so both the range and the set of outputs come from the display.
 */

interface VolumeInformation {
    target?: string;
    volume?: number;
    mute?: boolean;
    maxVolume?: number;
    minVolume?: number;
}

/** The output the top-level `audio.volume`/`audio.mute` states and SSIP notifications refer to. */
const PRIMARY_TARGET = 'speaker';

export class AudioModule implements FeatureModule {
    public readonly root = 'audio';
    public readonly name = 'audio';

    private outputs: string[] = [];
    /** Output ids whose state objects actually exist; empty until discovery has succeeded. */
    private readonly createdOutputs = new Set<string>();
    private primary = PRIMARY_TARGET;
    private setVolumeVersion = '1.0';
    private readonly speakerSettings: SettingsGroup;
    private readonly soundSettings: SettingsGroup;

    public constructor(private readonly ctx: DeviceContext) {
        this.speakerSettings = new SettingsGroup(ctx, {
            root: 'audio.speakerSettings',
            label: 'Speaker settings',
            service: 'audio',
            getMethod: 'getSpeakerSettings',
            setMethod: 'setSpeakerSettings',
            getVersions: ['1.0'],
            setVersions: ['1.0'],
        });
        this.soundSettings = new SettingsGroup(ctx, {
            root: 'audio.soundSettings',
            label: 'Sound settings',
            service: 'audio',
            getMethod: 'getSoundSettings',
            setMethod: 'setSoundSettings',
            getVersions: ['1.1', '1.0'],
            setVersions: ['1.1', '1.0'],
            // Professional displays document setSoundSettings without a paired getter.
            fallbackEntries: [
                {
                    target: 'outputTerminal',
                    currentValue: 'speaker',
                    candidate: [
                        { value: 'speaker' },
                        { value: 'speaker_hdmi' },
                        { value: 'hdmi' },
                        { value: 'audioSystem' },
                    ],
                },
            ],
        });
    }

    public async init(): Promise<void> {
        const { capabilities, store } = this.ctx;

        if (!capabilities.hasService('audio')) {
            return;
        }

        this.setVolumeVersion = capabilities.pickVersion('audio', 'setAudioVolume', ['1.2', '1.0']) ?? '1.0';
        const canSetVolume = capabilities.supports('audio', 'setAudioVolume');
        const canSetMute = capabilities.supports('audio', 'setAudioMute');

        await store.ensureChannel('audio', 'Audio');

        const information = await this.readVolumeInformation();
        this.outputs = information.map(entry => entry.target ?? '').filter(target => target !== '');
        this.primary = this.outputs.includes(PRIMARY_TARGET) ? PRIMARY_TARGET : (this.outputs[0] ?? PRIMARY_TARGET);
        const primaryInfo = information.find(entry => entry.target === this.primary);

        await store.ensureState('audio.volume', {
            name: 'Volume',
            type: 'number',
            // `level.volume` is defined as writable; a display without setAudioVolume needs
            // the read-only counterpart or the object checker rejects it and the user gets a
            // slider that silently does nothing.
            role: canSetVolume ? 'level.volume' : 'value',
            read: true,
            write: canSetVolume,
            min: primaryInfo?.minVolume ?? 0,
            max: primaryInfo?.maxVolume ?? 100,
        });
        await store.ensureState('audio.mute', {
            name: 'Mute',
            type: 'boolean',
            role: canSetMute ? 'switch' : 'indicator',
            read: true,
            write: canSetMute,
        });

        if (canSetVolume) {
            await store.ensureState('audio.volumeUp', {
                name: 'Volume up',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
            await store.ensureState('audio.volumeDown', {
                name: 'Volume down',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
        }

        // One channel per output the display actually reports.
        if (this.outputs.length > 0) {
            await store.ensureChannel('audio.outputs', 'Audio outputs');
            for (const entry of information) {
                if (!entry.target) {
                    continue;
                }
                const id = sanitiseId(entry.target);
                this.createdOutputs.add(id);
                await store.ensureChannel(`audio.outputs.${id}`, entry.target);
                await store.ensureState(`audio.outputs.${id}.volume`, {
                    name: `${entry.target} volume`,
                    type: 'number',
                    role: canSetVolume ? 'level.volume' : 'value',
                    read: true,
                    write: canSetVolume,
                    min: entry.minVolume ?? 0,
                    max: entry.maxVolume ?? 100,
                });
                // Read-only on purpose: setAudioMute takes only `status`, with no target, so a
                // per-output mute write would silently mute whatever the display's default
                // target is and then report the wrong output as muted. Use `audio.mute`.
                await store.ensureState(`audio.outputs.${id}.mute`, {
                    name: `${entry.target} mute`,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                });
            }
        }

        await this.speakerSettings.init();
        await this.soundSettings.init();
        await this.applyVolumeInformation(information);
    }

    private async readVolumeInformation(): Promise<VolumeInformation[]> {
        if (!this.ctx.capabilities.supports('audio', 'getVolumeInformation')) {
            return [];
        }
        try {
            const result = await this.ctx.rest.call<VolumeInformation[][]>('audio', 'getVolumeInformation');
            return Array.isArray(result[0]) ? result[0] : [];
        } catch (e) {
            this.ctx.reportError(e, 'audio.getVolumeInformation');
            return [];
        }
    }

    private async applyVolumeInformation(information: VolumeInformation[]): Promise<void> {
        const { store } = this.ctx;
        for (const entry of information) {
            if (!entry.target) {
                continue;
            }
            const id = sanitiseId(entry.target);
            if (this.createdOutputs.has(id)) {
                if (typeof entry.volume === 'number') {
                    await store.setAck(`audio.outputs.${id}.volume`, entry.volume);
                }
                if (typeof entry.mute === 'boolean') {
                    await store.setAck(`audio.outputs.${id}.mute`, entry.mute);
                }
            }
            if (entry.target === this.primary) {
                if (typeof entry.volume === 'number') {
                    await store.setAck('audio.volume', entry.volume);
                }
                if (typeof entry.mute === 'boolean') {
                    await store.setAck('audio.mute', entry.mute);
                }
            }
        }
    }

    public async refresh(): Promise<void> {
        if (!this.ctx.capabilities.hasService('audio')) {
            return;
        }
        await this.applyVolumeInformation(await this.readVolumeInformation());
        await this.speakerSettings.refresh();
        await this.soundSettings.refresh();
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        const { rest, store } = this.ctx;

        if (path === 'volume') {
            await this.setVolume(this.primary, String(Math.round(Number(value))));
            await store.setAck('audio.volume', Number(value));
            return true;
        }
        if (path === 'mute') {
            await rest.call('audio', 'setAudioMute', [{ status: Boolean(value) }]);
            await store.setAck('audio.mute', Boolean(value));
            return true;
        }
        // Relative steps are a first-class part of setAudioVolume, so no read-modify-write needed.
        if (path === 'volumeUp') {
            await this.setVolume(this.primary, '+1');
            return true;
        }
        if (path === 'volumeDown') {
            await this.setVolume(this.primary, '-1');
            return true;
        }

        // Only volume is per-output writable; mute has no target in the API.
        const output = /^outputs\.([^.]+)\.volume$/.exec(path);
        if (output) {
            const id = output[1];
            const target = this.outputs.find(candidate => sanitiseId(candidate) === id) ?? id;
            await this.setVolume(target, String(Math.round(Number(value))));
            await store.setAck(`audio.outputs.${id}.volume`, Number(value));
            return true;
        }

        if (path.startsWith('speakerSettings.')) {
            return this.speakerSettings.write(path.slice('speakerSettings.'.length), value);
        }
        if (path.startsWith('soundSettings.')) {
            return this.soundSettings.write(path.slice('soundSettings.'.length), value);
        }

        return false;
    }

    private async setVolume(target: string, volume: string): Promise<void> {
        // v1.0 and v1.2 share the target/volume pair; v1.2 adds the optional `ui` flag.
        await this.ctx.rest.call('audio', 'setAudioVolume', [{ target, volume }], this.setVolumeVersion);
    }

    public async onNotify(message: SsipMessage): Promise<boolean> {
        const { store } = this.ctx;
        const primaryId = sanitiseId(this.primary);

        if (message.command === SSIP_COMMANDS.volume) {
            const value = parseNumericAnswer(message.parameter);
            if (value !== null) {
                await store.setAck('audio.volume', value);
                if (this.createdOutputs.has(primaryId)) {
                    await store.setAck(`audio.outputs.${primaryId}.volume`, value);
                }
            }
            return true;
        }
        if (message.command === SSIP_COMMANDS.audioMute) {
            const value = parseNumericAnswer(message.parameter);
            if (value !== null) {
                await store.setAck('audio.mute', value === 1);
                if (this.createdOutputs.has(primaryId)) {
                    await store.setAck(`audio.outputs.${primaryId}.mute`, value === 1);
                }
            }
            return true;
        }
        return false;
    }
}
