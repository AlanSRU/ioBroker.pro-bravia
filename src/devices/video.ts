import { SSIP_COMMANDS, encodeNumericParam, parseNumericAnswer, type SsipMessage } from '../transport/ssip-protocol';
import { SettingsGroup } from './settings-group';
import type { DeviceContext, FeatureModule } from './types';

/**
 * Picture quality settings, picture mute and screen rotation.
 *
 * Picture mute has no REST equivalent at all — it exists only as the SSIP `PMUT` command — so
 * those states are created only when Simple IP Control is enabled.
 */

const ROTATIONS = ['0', '90', '180', '270'];

export class VideoModule implements FeatureModule {
    public readonly root = 'video';
    public readonly name = 'video';

    private readonly picture: SettingsGroup;
    private hasScreenRotation = false;

    public constructor(private readonly ctx: DeviceContext) {
        this.picture = new SettingsGroup(ctx, {
            root: 'video.picture',
            label: 'Picture quality',
            service: 'video',
            getMethod: 'getPictureQualitySettings',
            setMethod: 'setPictureQualitySettings',
            getVersions: ['1.1', '1.0'],
            setVersions: ['1.1', '1.0'],
            // Sony documents that batching these with other targets can fail on some signals.
            isolatedTargets: ['hdmiSignalFormat', 'hdmiSignalFormatVrr'],
        });
    }

    public async init(): Promise<void> {
        const { store, capabilities, ssip } = this.ctx;

        await store.ensureChannel('video', 'Video');
        await this.picture.init();

        if (ssip) {
            await store.ensureState('video.pictureMute', {
                name: 'Picture mute (black screen)',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
            });
            await store.ensureState('video.pictureMuteToggle', {
                name: 'Toggle picture mute',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
        }

        this.hasScreenRotation = capabilities.supports('video', 'getScreenRotation');
        if (this.hasScreenRotation) {
            const writable = capabilities.supports('video', 'setScreenRotation');
            await store.ensureState('video.screenRotation', {
                name: 'Screen rotation',
                type: 'string',
                role: 'text',
                read: true,
                write: writable,
                states: Object.fromEntries(ROTATIONS.map(value => [value, `${value}°`])),
            });
        }
    }

    public async refresh(): Promise<void> {
        const { rest, store, ssip } = this.ctx;

        await this.picture.refresh();

        if (this.hasScreenRotation) {
            try {
                const { rotation } = await rest.callFirst<{
                    rotation: number | string;
                }>('video', 'getScreenRotation');
                await store.setAck('video.screenRotation', String(rotation));
            } catch (e) {
                this.ctx.reportError(e, 'video.getScreenRotation');
            }
        }

        if (ssip?.isConnected) {
            try {
                const answer = await ssip.enquire(SSIP_COMMANDS.pictureMute);
                const value = parseNumericAnswer(answer.parameter);
                if (value !== null) {
                    await store.setAck('video.pictureMute', value === 1);
                }
            } catch (e) {
                this.ctx.reportError(e, 'ssip.PMUT');
            }
        }
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        const { rest, store, ssip } = this.ctx;

        if (path === 'pictureMute') {
            if (!ssip) {
                return false;
            }
            await ssip.controlChecked(SSIP_COMMANDS.pictureMute, encodeNumericParam(value ? 1 : 0));
            await store.setAck('video.pictureMute', Boolean(value));
            return true;
        }

        if (path === 'pictureMuteToggle') {
            if (!ssip) {
                return false;
            }
            await ssip.controlChecked(SSIP_COMMANDS.togglePictureMute);
            // The display answers the toggle without reporting the resulting state, so read it back.
            const answer = await ssip.enquire(SSIP_COMMANDS.pictureMute);
            const current = parseNumericAnswer(answer.parameter);
            if (current !== null) {
                await store.setAck('video.pictureMute', current === 1);
            }
            return true;
        }

        if (path === 'screenRotation') {
            // setScreenRotation is documented as callable from localhost only, and only on
            // recent FW-BZxxx firmware; surface that clearly if the display refuses.
            await rest.call('video', 'setScreenRotation', [{ rotation: Number(value) }]);
            await store.setAck('video.screenRotation', String(value));
            return true;
        }

        if (path.startsWith('picture.')) {
            return this.picture.write(path.slice('picture.'.length), value);
        }

        return false;
    }

    public async onNotify(message: SsipMessage): Promise<boolean> {
        if (message.command !== SSIP_COMMANDS.pictureMute) {
            return false;
        }
        const value = parseNumericAnswer(message.parameter);
        if (value !== null) {
            await this.ctx.store.setAck('video.pictureMute', value === 1);
        }
        return true;
    }
}
