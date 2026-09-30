import { BraviaDevice, type BraviaDeviceOptions } from '../src/device';
import { MemoryStateStore } from '../src/lib/state-store';
import { wake } from '../src/transport/wol';
import { MockBraviaDisplay } from './mock-bravia-server';

// The magic packet itself is covered by the transport tests; here only who sends it, and where.
jest.mock('../src/transport/wol', () => ({ wake: jest.fn(() => Promise.resolve()) }));
const wakeMock = wake as jest.MockedFunction<typeof wake>;

describe('Wake-on-LAN', () => {
    let display: MockBraviaDisplay | undefined;
    let device: BraviaDevice | undefined;

    beforeEach(() => wakeMock.mockClear());

    afterEach(async () => {
        device?.ssip?.close();
        await display?.stop();
        display = undefined;
    });

    describe('a display that is suspended when the instance starts', () => {
        // Nothing listens here, so every HTTP call fails exactly as it does against a suspended
        // panel whose HTTP server is down.
        const suspended = (options: Partial<BraviaDeviceOptions>, store: MemoryStateStore): BraviaDevice =>
            new BraviaDevice(
                { host: '127.0.0.1', psk: '1234', httpPort: 1, useSsip: false, useIrcc: false, ...options },
                store,
            );

        it('exposes power.wake before discovery has ever succeeded', async () => {
            const store = new MemoryStateStore();
            device = suspended({ macAddress: '00:11:22:33:44:55' }, store);
            await device.prepare();
            await expect(device.initialise()).rejects.toMatchObject({ kind: 'transport' });

            // On a fresh install this is the only state that could bring the display back.
            expect(store.objects.get('power.wake')?.common).toMatchObject({ role: 'button', write: true });
            expect(store.objects.get('power')?.type).toBe('channel');
        });

        it('wakes it using the configured MAC', async () => {
            const store = new MemoryStateStore();
            device = suspended({ macAddress: '00:11:22:33:44:55' }, store);
            await device.prepare();
            await device.initialise().catch(() => undefined);

            await expect(device.write('power.wake', true)).resolves.toBe(true);
            expect(wakeMock).toHaveBeenCalledWith('00:11:22:33:44:55', expect.anything());
        });

        it('wakes it on power.state = true using the MAC stored by an earlier run', async () => {
            const store = new MemoryStateStore();
            await store.setAck('info.macAddress', '12:34:56:78:9A:BC');
            device = suspended({}, store);
            await device.prepare();
            await device.initialise().catch(() => undefined);

            await expect(device.write('power.state', true)).resolves.toBe(true);
            expect(wakeMock).toHaveBeenCalledWith('12:34:56:78:9A:BC', expect.anything());
        });

        it('still refuses every other write until discovery has run', async () => {
            const store = new MemoryStateStore();
            device = suspended({ macAddress: '00:11:22:33:44:55' }, store);
            await device.prepare();
            await device.initialise().catch(() => undefined);

            await expect(device.write('power.state', false)).rejects.toMatchObject({ kind: 'retryable' });
            await expect(device.write('audio.volume', 10)).rejects.toMatchObject({ kind: 'retryable' });
            expect(wakeMock).not.toHaveBeenCalled();
        });
    });

    describe('broadcast address', () => {
        const connected = async (options: Partial<BraviaDeviceOptions>): Promise<void> => {
            display = new MockBraviaDisplay();
            await display.start();
            device = new BraviaDevice(
                {
                    host: '127.0.0.1',
                    psk: '1234',
                    httpPort: display.httpPort,
                    useSsip: true,
                    ssipPort: display.ssipPort,
                    useIrcc: false,
                    ...options,
                },
                new MemoryStateStore(),
            );
            device.ssip!.connect();
            await new Promise<void>(resolve => device!.ssip!.once('connect', () => resolve()));
            await device.initialise();
        };

        it('uses the configured address over the one the display reports', async () => {
            // e.g. a unicast relay, because the display's subnet broadcast does not cross VLANs.
            await connected({ broadcastAddress: '10.20.0.15' });
            await device!.write('power.wake', true);
            expect(wakeMock).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ broadcastAddress: '10.20.0.15' }),
            );
        });

        it('uses a configured MAC over the one the display reports, once discovery has run', async () => {
            // The mock reports 12:34:56:78:9A:BC; before discovery the configured one wins too.
            await connected({ macAddress: '00:11:22:33:44:55' });
            await device!.write('power.wake', true);
            expect(wakeMock).toHaveBeenCalledWith('00:11:22:33:44:55', expect.anything());
        });

        it('falls back to the address the display reports over SSIP', async () => {
            await connected({});
            await device!.write('power.wake', true);
            expect(wakeMock).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ broadcastAddress: '192.168.0.255' }),
            );
        });
    });
});

describe('application ids', () => {
    it('stay valid and distinct for titles ioBroker cannot use as ids', async () => {
        const display = new MockBraviaDisplay();
        display.applications = [
            { title: 'YouTube™', uri: 'com.google.android.youtube.tv', icon: '' },
            { title: '設定', uri: 'com.sony.dtv.settings', icon: '' },
            { title: 'ヘルプ', uri: 'com.sony.dtv.help', icon: '' },
        ];
        await display.start();
        const store = new MemoryStateStore();
        const device = new BraviaDevice(
            { host: '127.0.0.1', psk: '1234', httpPort: display.httpPort, useSsip: false, useIrcc: false },
            store,
        );
        try {
            await device.initialise();
            const items = await store.childIds('apps.items');
            expect(items.sort()).toEqual(['YouTube_', 'com_sony_dtv_help', 'com_sony_dtv_settings']);
        } finally {
            await display.stop();
        }
    });
});
