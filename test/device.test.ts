import { BraviaDevice } from '../src/device';
import { MemoryStateStore, parentIds } from '../src/lib/state-store';
import { MockBraviaDisplay } from './mock-bravia-server';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

describe('BraviaDevice against a mock display', () => {
    let display: MockBraviaDisplay;
    let store: MemoryStateStore;
    let device: BraviaDevice;

    const build = async (mock: MockBraviaDisplay): Promise<void> => {
        display = mock;
        await display.start();
        store = new MemoryStateStore();
        device = new BraviaDevice(
            {
                host: '127.0.0.1',
                psk: '1234',
                httpPort: display.httpPort,
                useSsip: true,
                ssipPort: display.ssipPort,
                useIrcc: true,
            },
            store,
        );
        device.ssip!.connect();
        await new Promise<void>(resolve => device.ssip!.once('connect', () => resolve()));
        await waitFor(() => display.ssipClientCount === 1);
        await device.initialise();
    };

    afterEach(async () => {
        device?.ssip?.close();
        await display?.stop();
    });

    describe('state tree construction', () => {
        beforeEach(async () => {
            await build(new MockBraviaDisplay());
        });

        it('creates the discovered picture quality targets with their reported ranges', () => {
            const color = store.objects.get('video.picture.color');
            expect(color?.common).toMatchObject({ type: 'number', role: 'level', min: 0, max: 100, step: 1 });

            const pictureMode = store.objects.get('video.picture.pictureMode');
            expect(pictureMode?.common.states).toMatchObject({ standard: 'Standard', vivid: 'Vivid' });

            // A two-value on/off target is exposed as a boolean switch.
            expect(store.objects.get('video.picture.lightSensor')?.common).toMatchObject({
                type: 'boolean',
                role: 'switch',
            });
        });

        it('creates states for targets the display currently reports as unavailable', () => {
            // isAvailable:false means "not applicable to the current input", so the state must exist.
            expect(store.objects.has('video.picture.hdrMode')).toBe(true);
        });

        it('populates values discovered at startup', async () => {
            expect(await store.getValue('video.picture.color')).toBe(50);
            expect(await store.getValue('video.picture.pictureMode')).toBe('standard');
            expect(await store.getValue('video.picture.lightSensor')).toBe(false);
        });

        it('builds the input tree from the display, including user labels', async () => {
            expect(store.objects.has('input.sources.hdmi1.select')).toBe(true);
            expect(await store.getValue('input.sources.hdmi1.label')).toBe('Playout PC');
            expect(await store.getValue('input.sources.hdmi1.connected')).toBe(true);
            expect(await store.getValue('input.sources.hdmi2.connected')).toBe(false);
            expect(store.objects.get('input.select')?.common.states).toMatchObject({
                'extInput:hdmi?port=1': 'Playout PC',
                'extInput:hdmi?port=2': 'HDMI 2',
            });
        });

        it('reads static system information once', async () => {
            expect(await store.getValue('info.model')).toBe('FW-85BZ35P');
            expect(await store.getValue('info.serial')).toBe('1000001');
            expect(await store.getValue('info.macAddress')).toBe('12:34:56:78:9A:BC');
            expect(await store.getValue('info.ipAddress')).toBe('192.168.0.14');
        });

        it('exposes remote keys discovered from the display alongside the SSIP table', () => {
            // From getRemoteControllerInfo.
            expect(store.objects.has('remote.keys.Hdmi1')).toBe(true);
            // From the SSIP numeric code table.
            expect(store.objects.has('remote.keys.PictureOff')).toBe(true);
        });

        it('creates audio outputs and settings groups from discovery', () => {
            expect(store.objects.has('audio.outputs.speaker.volume')).toBe(true);
            expect(store.objects.has('audio.outputs.headphone.volume')).toBe(true);
            expect(store.objects.has('audio.speakerSettings.tvPosition')).toBe(true);
            expect(store.objects.has('audio.soundSettings.outputTerminal')).toBe(true);
        });

        it('creates a parent object for every intermediate path segment', () => {
            // repochecker E3009: a state whose parent channel is missing fails repository review.
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

        it('handles every writable state it creates', () => {
            // A writable state with no matching handler would silently swallow user commands.
            const unhandled: string[] = [];
            for (const id of store.writableStates()) {
                const separator = id.indexOf('.');
                const root = id.slice(0, separator);
                if (!device.writableRoots.includes(root)) {
                    unhandled.push(`${id} (no handler for root "${root}")`);
                }
            }
            expect(unhandled).toEqual([]);
        });
    });

    describe('writes reach the display', () => {
        beforeEach(async () => {
            await build(new MockBraviaDisplay());
        });

        it('sets power via REST', async () => {
            expect(await device.write('power.state', false)).toBe(true);
            expect(display.power).toBe(false);
        });

        it('sets volume and mute', async () => {
            expect(await device.write('audio.volume', 55)).toBe(true);
            expect(display.volume).toBe(55);
            expect(await device.write('audio.mute', true)).toBe(true);
            expect(display.audioMute).toBe(true);
        });

        it('steps the volume relatively rather than reading and writing back', async () => {
            display.volume = 20;
            expect(await device.write('audio.volumeUp', true)).toBe(true);
            expect(display.volume).toBe(21);
            expect(await device.write('audio.volumeDown', true)).toBe(true);
            expect(display.volume).toBe(20);
        });

        it('writes a discovered picture target with the right wire value', async () => {
            expect(await device.write('video.picture.color', 77)).toBe(true);
            expect(display.pictureSettings.find(s => s.target === 'color')?.currentValue).toBe('77');

            // The boolean mapping converts back to the display's own on/off strings.
            expect(await device.write('video.picture.lightSensor', true)).toBe(true);
            expect(display.pictureSettings.find(s => s.target === 'lightSensor')?.currentValue).toBe('on');
        });

        it('switches input from both the selector and the per-input button', async () => {
            expect(await device.write('input.select', 'extInput:hdmi?port=2')).toBe(true);
            expect(display.input.port).toBe(2);

            expect(await device.write('input.sources.hdmi3.select', true)).toBe(true);
            expect(display.input.port).toBe(3);
        });

        it('drives picture mute over SSIP, which has no REST equivalent', async () => {
            expect(await device.write('video.pictureMute', true)).toBe(true);
            expect(display.pictureMute).toBe(true);
            expect(await device.write('video.pictureMuteToggle', true)).toBe(true);
            expect(display.pictureMute).toBe(false);
        });

        it('toggles power over SSIP', async () => {
            display.power = true;
            expect(await device.write('power.toggle', true)).toBe(true);
            expect(display.power).toBe(false);
        });

        it('sets the scene setting', async () => {
            expect(await device.write('scene.setting', 'general')).toBe(true);
            expect(display.sceneSetting).toBe('general');
        });

        it('sends both halves of the LED indicator together', async () => {
            expect(await device.write('system.led.mode', 'Dark')).toBe(true);
            expect(display.ledIndicator.mode).toBe('Dark');
            // Writing only the status must preserve the mode rather than resetting it.
            expect(await device.write('system.led.status', false)).toBe(true);
            expect(display.ledIndicator).toEqual({ mode: 'Dark', status: 'false' });
        });

        it('launches an application from its discovered button', async () => {
            expect(await device.write('apps.items.BRAVIA_Signage.launch', true)).toBe(true);
            const request = display.requests.filter(r => r.method === 'setActiveApp').pop();
            expect(request?.params).toEqual([{ uri: 'com.sony.dtv.signage' }]);
        });

        it('sends a remote key over IRCC', async () => {
            expect(await device.write('remote.keys.Hdmi1', true)).toBe(true);
        });

        it('returns false for an id no module owns', async () => {
            expect(await device.write('nonsense.thing', 1)).toBe(false);
            expect(await device.write('audio.notAThing', 1)).toBe(false);
        });
    });

    describe('SSIP notifications update state without polling', () => {
        beforeEach(async () => {
            await build(new MockBraviaDisplay());
            device.ssip!.on('notify', message => {
                void device.handleNotify(message);
            });
        });

        it('reflects power, volume, mute, picture mute and input changes pushed by the display', async () => {
            display.setPower(false);
            await waitFor(async () => (await store.getValue('power.state')) === false);
            expect(await store.getValue('power.status')).toBe('standby');

            display.setVolume(64);
            await waitFor(async () => (await store.getValue('audio.volume')) === 64);
            expect(await store.getValue('audio.outputs.speaker.volume')).toBe(64);

            display.setAudioMute(true);
            await waitFor(async () => (await store.getValue('audio.mute')) === true);

            display.setPictureMute(true);
            await waitFor(async () => (await store.getValue('video.pictureMute')) === true);

            display.setInput(2);
            await waitFor(async () => (await store.getValue('input.current')) === 'extInput:hdmi?port=2');
            expect(await store.getValue('input.currentTitle')).toBe('HDMI 2');
        });
    });

    describe('liveness is reported honestly', () => {
        it('rejects refresh when the display stops answering, so info.connection can go false', async () => {
            await build(new MockBraviaDisplay());
            await expect(device.refresh()).resolves.toBeUndefined();

            // Per-module failures are swallowed by design, so only an unguarded probe can
            // tell the adapter the display has gone.
            await display.stop();
            await expect(device.refresh()).rejects.toMatchObject({ kind: 'transport' });
        });

        it('rejects initialise when the pre-shared key is wrong', async () => {
            display = new MockBraviaDisplay({ psk: 'correct-key' });
            await display.start();
            store = new MemoryStateStore();
            device = new BraviaDevice(
                { host: '127.0.0.1', psk: 'wrong-key', httpPort: display.httpPort, useSsip: false, useIrcc: false },
                store,
            );
            // Without this the instance would show green forever with a mistyped key.
            await expect(device.initialise()).rejects.toMatchObject({ kind: 'auth' });
        });

        it('warns once per context rather than on every failed call', async () => {
            await build(new MockBraviaDisplay());
            await display.stop();

            for (let i = 0; i < 3; i++) {
                await device.refresh().catch(() => undefined);
            }
            // An unreachable display fails many calls per cycle; the log must not scale with it.
            const warnings = store.logs.filter(line => line.startsWith('warn:'));
            expect(new Set(warnings).size).toBe(warnings.length);
        });

        it('does not repeat a warning for a call that keeps failing on a reachable display', async () => {
            // The display answers getPowerStatus but one call fails persistently - a real case
            // for these displays, e.g. getPlayingContentInfo while a signage app is foregrounded.
            await build(new MockBraviaDisplay({ unsupportedMethods: [] }));
            display.failMethod = 'getPlayingContentInfo';

            for (let i = 0; i < 4; i++) {
                await device.refresh();
            }

            const warnings = store.logs.filter(
                line => line.startsWith('warn:') && line.includes('getPlayingContentInfo'),
            );
            // Once, not once per poll - otherwise it is ~2,880 identical lines a day.
            expect(warnings).toHaveLength(1);
        });
    });

    describe('stop() halts work in flight', () => {
        it('stops refreshing and stops writing state', async () => {
            await build(new MockBraviaDisplay());
            device.stop();

            const before = new Map(store.values);
            display.volume = 99;
            await device.refresh();

            // A stop during a slow refresh must not keep writing to a torn-down instance.
            expect(store.values.get('audio.volume')).toEqual(before.get('audio.volume'));
        });
    });

    describe('discovered children are pruned when the display drops them', () => {
        it('removes an app channel for an app that is no longer installed', async () => {
            const mock = new MockBraviaDisplay();
            mock.applications = [{ title: 'BRAVIA Signage', uri: 'com.sony.dtv.signage', icon: '' }];
            await build(mock);

            expect(store.objects.has('apps.items.BRAVIA_Signage')).toBe(true);
            // A stale entry left over from a previous run, as after an uninstall.
            await store.ensureChannel('apps.items.Old_App', 'Old App');
            await store.ensureState('apps.items.Old_App.launch', {
                name: 'Launch',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });

            await device.initialise();

            expect(store.objects.has('apps.items.Old_App')).toBe(false);
            expect(store.objects.has('apps.items.Old_App.launch')).toBe(false);
            expect(store.objects.has('apps.items.BRAVIA_Signage')).toBe(true);
        });

        it('removes an input channel the display no longer reports', async () => {
            await build(new MockBraviaDisplay());
            await store.ensureChannel('input.sources.hdmi9', 'HDMI 9');
            await device.initialise();
            expect(store.objects.has('input.sources.hdmi9')).toBe(false);
            expect(store.objects.has('input.sources.hdmi1')).toBe(true);
        });
    });

    describe('values the display never reported are not published', () => {
        it('leaves sound settings at their default when there is no getter', async () => {
            // Professional displays document setSoundSettings without a paired getter.
            await build(new MockBraviaDisplay({ unsupportedMethods: ['getSoundSettings'] }));

            // The state must still exist so the target is controllable...
            expect(store.objects.has('audio.soundSettings.outputTerminal')).toBe(true);
            // ...but its value must not be a guess presented as a reading.
            expect(await store.getValue('audio.soundSettings.outputTerminal')).toBeUndefined();
        });
    });

    describe('audio states match what the display can actually do', () => {
        it('makes per-output mute read-only, since setAudioMute has no target', async () => {
            await build(new MockBraviaDisplay());
            expect(store.objects.get('audio.outputs.headphone.mute')?.common).toMatchObject({
                role: 'indicator',
                write: false,
            });
            // The global mute remains controllable.
            expect(store.objects.get('audio.mute')?.common).toMatchObject({ role: 'switch', write: true });
        });

        it('uses read-only roles when the display cannot set volume or mute', async () => {
            await build(new MockBraviaDisplay({ unsupportedMethods: ['setAudioVolume', 'setAudioMute'] }));
            expect(store.objects.get('audio.volume')?.common).toMatchObject({ role: 'value', write: false });
            expect(store.objects.get('audio.mute')?.common).toMatchObject({ role: 'indicator', write: false });
            expect(store.objects.has('audio.volumeUp')).toBe(false);
        });
    });

    describe('capability differences change the state tree', () => {
        it('omits scene setting on models that do not implement videoScreen', async () => {
            // BZ40P / BZ35P / BZ30P do not support setSceneSetting.
            await build(
                new MockBraviaDisplay({
                    model: 'FW-55BZ40P',
                    services: ['guide', 'system', 'audio', 'avContent', 'video', 'appControl'],
                }),
            );
            expect(store.objects.has('scene.setting')).toBe(false);
            expect(store.objects.has('video.picture.color')).toBe(true);
        });

        it('creates a read-only state when the display offers a getter but no setter', async () => {
            await build(new MockBraviaDisplay({ unsupportedMethods: ['setWolMode'] }));
            expect(store.objects.get('system.wolMode')?.common).toMatchObject({ read: true, write: false });
        });

        it('omits the reboot button when the display cannot reboot', async () => {
            await build(new MockBraviaDisplay({ unsupportedMethods: ['requestReboot'] }));
            expect(store.objects.has('power.reboot')).toBe(false);
        });
    });

    describe('a display that is in standby at adapter start', () => {
        beforeEach(async () => {
            await build(new MockBraviaDisplay({ powerOn: false }));
        });

        it('completes the state tree once the display is switched on', async () => {
            // In standby the display refuses everything except the system basics, so discovery
            // comes back empty. getPowerStatus still answers, so nothing throws and nothing
            // reschedules — the tree must be completed when the panel wakes.
            expect(store.objects.has('input.sources.hdmi1')).toBe(false);

            display.setPower(true);
            await device.refresh();

            expect(store.objects.has('input.sources.hdmi1')).toBe(true);
            expect(store.objects.has('audio.outputs.speaker.volume')).toBe(true);
            expect(store.objects.has('video.picture.color')).toBe(true);
            expect(store.objects.get('input.select')?.common.states).toMatchObject({
                'extInput:hdmi?port=1': 'Playout PC',
            });
        });

        it('never writes a value to an id it has not created', async () => {
            display.setPower(true);
            await device.refresh();
            await device.refresh();

            const orphans = [...store.values.keys()].filter(id => !store.objects.has(id));
            expect(orphans).toEqual([]);
        });
    });

    describe('a display in standby', () => {
        beforeEach(async () => {
            await build(new MockBraviaDisplay({ powerOn: false }));
        });

        it('still builds the tree and reports standby without flooding the log with warnings', async () => {
            await device.refresh();
            expect(await store.getValue('power.state')).toBe(false);
            expect(await store.getValue('power.status')).toBe('standby');
            expect(store.logs.filter(line => line.startsWith('warn:'))).toEqual([]);
        });
    });
});
