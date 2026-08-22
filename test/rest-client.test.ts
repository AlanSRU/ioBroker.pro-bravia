import { BraviaRestClient } from '../src/transport/rest-client';
import { BraviaError } from '../src/lib/errors';
import { MockBraviaDisplay } from './mock-bravia-server';

describe('BraviaRestClient', () => {
    let display: MockBraviaDisplay;
    let client: BraviaRestClient;

    beforeEach(async () => {
        display = new MockBraviaDisplay({ psk: 'secret' });
        await display.start();
        client = new BraviaRestClient({ host: '127.0.0.1', port: display.httpPort, psk: 'secret' });
    });

    afterEach(async () => {
        await display.stop();
    });

    it('performs a JSON-RPC call and unwraps the result array', async () => {
        const info = await client.callFirst<{ model: string }>('system', 'getSystemInformation');
        expect(info.model).toBe('FW-85BZ35P');
        expect(display.requests[0]).toMatchObject({
            service: 'system',
            method: 'getSystemInformation',
            version: '1.0',
        });
    });

    it('sends the version and params it was given', async () => {
        await client.call('video', 'getPictureQualitySettings', [{ target: 'color' }], '1.1');
        expect(display.requests[0]).toMatchObject({
            service: 'video',
            method: 'getPictureQualitySettings',
            params: [{ target: 'color' }],
            version: '1.1',
        });
    });

    it('classifies a bad pre-shared key as an auth error', async () => {
        const wrong = new BraviaRestClient({ host: '127.0.0.1', port: display.httpPort, psk: 'nope' });
        await expect(wrong.call('system', 'getPowerStatus')).rejects.toMatchObject({
            kind: 'auth',
            code: 403,
        });
    });

    it('classifies an unknown method as unsupported so callers can stop asking', async () => {
        await expect(client.call('system', 'getNonsense')).rejects.toMatchObject({ kind: 'unsupported', code: 12 });
    });

    it('classifies standby refusals as displayOff rather than a hard failure', async () => {
        display.power = false;
        await expect(client.call('avContent', 'getPlayingContentInfo')).rejects.toMatchObject({
            kind: 'displayOff',
            code: 40005,
        });
    });

    it('marks transport failures as retryable', async () => {
        await display.stop();
        const error = await client.call('system', 'getPowerStatus').catch((e: BraviaError) => e);
        expect(error).toBeInstanceOf(BraviaError);
        expect((error as BraviaError).kind).toBe('transport');
        expect((error as BraviaError).isRetryable).toBe(true);
    });

    it('serialises concurrent calls so the display never sees overlapping requests', async () => {
        await Promise.all([
            client.call('system', 'getPowerStatus'),
            client.call('audio', 'getVolumeInformation'),
            client.call('video', 'getPictureQualitySettings', [{ target: '' }], '1.1'),
        ]);
        expect(display.requests.map(r => r.method)).toEqual([
            'getPowerStatus',
            'getVolumeInformation',
            'getPictureQualitySettings',
        ]);
    });

    it('keeps serving later calls after an earlier one rejects', async () => {
        const failure = client.call('system', 'getNonsense').catch(() => 'failed');
        const success = client.callFirst<{ status: string }>('system', 'getPowerStatus');
        expect(await failure).toBe('failed');
        expect((await success).status).toBe('active');
    });

    it('allocates a fresh non-zero id per request', async () => {
        await client.call('system', 'getPowerStatus');
        await client.call('system', 'getPowerStatus');
        const ids = display.requests.map((_, index) => index + 1);
        expect(ids.every(id => id > 0)).toBe(true);
        expect(display.requests).toHaveLength(2);
    });

    it('rejects when the result array is empty but callFirst was used', async () => {
        await expect(client.callFirst('system', 'requestReboot')).rejects.toMatchObject({ kind: 'unknown' });
    });
});
