import { Capabilities } from '../src/discovery/capabilities';
import { BraviaRestClient } from '../src/transport/rest-client';
import { MockBraviaDisplay } from './mock-bravia-server';

describe('Capabilities discovery', () => {
    let display: MockBraviaDisplay;

    const clientFor = (d: MockBraviaDisplay): BraviaRestClient =>
        new BraviaRestClient({ host: '127.0.0.1', port: d.httpPort, psk: '1234' });

    afterEach(async () => {
        await display.stop();
    });

    it('reads the supported service and method list from the display', async () => {
        display = new MockBraviaDisplay();
        await display.start();
        const capabilities = await Capabilities.discover(clientFor(display));

        expect(capabilities.assumed).toBe(false);
        expect(capabilities.serviceNames).toContain('videoScreen');
        expect(capabilities.supports('system', 'getPowerStatus')).toBe(true);
        expect(capabilities.supports('system', 'getScreenshot')).toBe(false);
    });

    it('reports a service the display does not expose as absent', async () => {
        // BZ40P/BZ35P/BZ30P do not implement videoScreen scene settings.
        display = new MockBraviaDisplay({
            services: ['guide', 'system', 'audio', 'avContent', 'video'],
        });
        await display.start();
        const capabilities = await Capabilities.discover(clientFor(display));

        expect(capabilities.hasService('videoScreen')).toBe(false);
        expect(capabilities.supports('videoScreen', 'setSceneSetting')).toBe(false);
        expect(capabilities.hasService('audio')).toBe(true);
    });

    it('honours per-method removals', async () => {
        display = new MockBraviaDisplay({ unsupportedMethods: ['setWolMode'] });
        await display.start();
        const capabilities = await Capabilities.discover(clientFor(display));

        expect(capabilities.supports('system', 'getWolMode')).toBe(true);
        expect(capabilities.supports('system', 'setWolMode')).toBe(false);
    });

    it('falls back to assuming support when the guide service is unavailable', async () => {
        display = new MockBraviaDisplay({ services: ['system'] });
        await display.start();
        const capabilities = await Capabilities.discover(clientFor(display));

        expect(capabilities.assumed).toBe(true);
        // In assumed mode nothing is ruled out, so the adapter degrades to trying and handling errors.
        expect(capabilities.supports('videoScreen', 'setSceneSetting')).toBe(true);
        expect(capabilities.pickVersion('video', 'getPictureQualitySettings', ['1.1', '1.0'])).toBe('1.0');
    });

    it('picks the newest preferred version the display actually offers', () => {
        const capabilities = Capabilities.fromServices([
            {
                service: 'video',
                apis: [
                    {
                        name: 'getPictureQualitySettings',
                        versions: [{ version: '1.0' }, { version: '1.1' }],
                    },
                    { name: 'setScreenRotation', versions: [{ version: '1.0' }] },
                ],
            },
        ]);

        expect(capabilities.pickVersion('video', 'getPictureQualitySettings', ['1.1', '1.0'])).toBe('1.1');
        expect(capabilities.pickVersion('video', 'setScreenRotation', ['1.1', '1.0'])).toBe('1.0');
        // Nothing preferred is available -> caller must skip the feature entirely.
        expect(capabilities.pickVersion('video', 'setScreenRotation', ['2.0'])).toBeUndefined();
        expect(capabilities.pickVersion('video', 'getNonexistent', ['1.0'])).toBeUndefined();
    });

    it('ignores malformed service entries rather than throwing', () => {
        const capabilities = Capabilities.fromServices([
            null as never,
            { service: 'system', apis: [null as never, { name: 'getPowerStatus', versions: [] }] },
        ]);
        expect(capabilities.supports('system', 'getPowerStatus')).toBe(true);
        // A method with no declared versions still defaults to 1.0.
        expect(capabilities.pickVersion('system', 'getPowerStatus', ['1.0'])).toBe('1.0');
    });
});
