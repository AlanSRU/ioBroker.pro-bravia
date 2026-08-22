import type { DeviceContext, FeatureModule } from './types';

/**
 * Scene setting (`videoScreen` service).
 *
 * Not implemented by the BZ40P / BZ35P / BZ30P models, and the candidate list depends on the
 * current input source — so both the existence of the state and its allowed values come from
 * the display rather than from a table here.
 */

interface SceneSetting {
    currentValue?: string;
    candidate?: string[];
}

export class VideoScreenModule implements FeatureModule {
    public readonly root = 'scene';
    public readonly name = 'videoScreen';

    private available = false;

    public constructor(private readonly ctx: DeviceContext) {}

    public async init(): Promise<void> {
        const { store, capabilities } = this.ctx;

        if (!capabilities.supports('videoScreen', 'getSceneSetting')) {
            store.log.debug('Scene setting is not supported by this display');
            return;
        }

        const setting = await this.read();
        if (!setting) {
            return;
        }
        this.available = true;

        await store.ensureChannel('scene', 'Scene setting');
        await store.ensureState('scene.setting', {
            name: 'Scene setting',
            type: 'string',
            role: 'text',
            read: true,
            write: capabilities.supports('videoScreen', 'setSceneSetting'),
            // An empty candidate list means "not available for the current input", so fall back
            // to the three documented values rather than creating a state with no options.
            states: Object.fromEntries(
                (setting.candidate?.length ? setting.candidate : ['auto', 'auto24pSync', 'general']).map(value => [
                    value,
                    value,
                ]),
            ),
        });
        await store.setAck('scene.setting', setting.currentValue ?? '');
    }

    private async read(): Promise<SceneSetting | null> {
        try {
            return await this.ctx.rest.callFirst<SceneSetting>('videoScreen', 'getSceneSetting');
        } catch (e) {
            this.ctx.reportError(e, 'videoScreen.getSceneSetting');
            return null;
        }
    }

    public async refresh(): Promise<void> {
        if (!this.available) {
            return;
        }
        const setting = await this.read();
        if (setting?.currentValue !== undefined) {
            await this.ctx.store.setAck('scene.setting', setting.currentValue);
        }
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        if (path !== 'setting') {
            return false;
        }
        await this.ctx.rest.call('videoScreen', 'setSceneSetting', [{ value: String(value) }]);
        await this.ctx.store.setAck('scene.setting', value);
        return true;
    }
}
