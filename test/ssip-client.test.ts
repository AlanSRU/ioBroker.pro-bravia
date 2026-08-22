import { SsipClient } from '../src/transport/ssip-client';
import {
    PARAM_SUCCESS,
    encodeInputParam,
    encodeNumericParam,
    parseNumericAnswer,
    parseStringAnswer,
    type SsipMessage,
} from '../src/transport/ssip-protocol';
import { MockBraviaDisplay } from './mock-bravia-server';

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

const once = (client: SsipClient, event: 'connect' | 'disconnect'): Promise<void> =>
    new Promise(resolve => client.once(event, () => resolve()));

describe('SsipClient', () => {
    let display: MockBraviaDisplay;
    let client: SsipClient;

    beforeEach(async () => {
        display = new MockBraviaDisplay();
        await display.start();
        client = new SsipClient({ host: '127.0.0.1', port: display.ssipPort, commandTimeoutMs: 1000 });
    });

    afterEach(async () => {
        client.close();
        await display.stop();
    });

    it('connects and reports connection state', async () => {
        const connected = once(client, 'connect');
        client.connect();
        await connected;
        expect(client.isConnected).toBe(true);
        await waitFor(() => display.ssipClientCount === 1);
    });

    it('enquires the current power state', async () => {
        display.power = true;
        client.connect();
        await once(client, 'connect');
        const answer = await client.enquire('POWR');
        expect(parseNumericAnswer(answer.parameter)).toBe(1);
    });

    it('sends control commands that change the display', async () => {
        client.connect();
        await once(client, 'connect');
        await client.controlChecked('VOLU', encodeNumericParam(42));
        expect(display.volume).toBe(42);
    });

    it('throws on an error answer', async () => {
        client.connect();
        await once(client, 'connect');
        // Volume 150 is out of range, so the mock answers with F...F.
        await expect(client.controlChecked('VOLU', encodeNumericParam(150))).rejects.toMatchObject({
            kind: 'badRequest',
        });
    });

    it('throws "unsupported" on a not-found answer', async () => {
        client.connect();
        await once(client, 'connect');
        await expect(client.controlChecked('INPT', encodeInputParam('hdmi', 9))).rejects.toMatchObject({
            kind: 'unsupported',
        });
    });

    it('reads string answers such as the MAC address', async () => {
        client.connect();
        await once(client, 'connect');
        const answer = await client.enquire('MADR', 'eth0############');
        expect(parseStringAnswer(answer.parameter)).toBe('123456789ABC');
    });

    it('emits unsolicited notify frames', async () => {
        const notifications: SsipMessage[] = [];
        client.on('notify', message => notifications.push(message));
        client.connect();
        await once(client, 'connect');
        // The client's TCP connect can win the race against the server's accept handler,
        // so wait until the display has actually registered us before it pushes anything.
        await waitFor(() => display.ssipClientCount === 1);

        display.setVolume(33);
        display.setInput(2);

        await waitFor(() => notifications.length === 2);
        expect(notifications[0].command).toBe('VOLU');
        expect(parseNumericAnswer(notifications[0].parameter)).toBe(33);
        expect(notifications[1].command).toBe('INPT');
    });

    it('does not mistake a notify frame for a pending command answer', async () => {
        client.connect();
        await once(client, 'connect');

        // Push a POWR notify while a POWR enquiry is in flight; the answer must still win.
        const answer = client.enquire('POWR');
        display.notify('POWR', encodeNumericParam(0));
        const resolved = await answer;
        expect(resolved.type).toBe('A');
    });

    it('serialises commands so answers cannot be cross-matched', async () => {
        client.connect();
        await once(client, 'connect');
        await Promise.all([
            client.control('VOLU', encodeNumericParam(11)),
            client.control('AMUT', encodeNumericParam(1)),
            client.control('PMUT', encodeNumericParam(1)),
        ]);
        expect(display.ssipRequests.map(r => r.command)).toEqual(['VOLU', 'AMUT', 'PMUT']);
        expect(display.volume).toBe(11);
        expect(display.audioMute).toBe(true);
        expect(display.pictureMute).toBe(true);
    });

    it('rejects commands issued while disconnected', async () => {
        await expect(client.control('POWR', PARAM_SUCCESS)).rejects.toMatchObject({ kind: 'transport' });
    });

    it('reconnects after the display drops the connection', async () => {
        const port = display.ssipPort;
        client = new SsipClient({
            host: '127.0.0.1',
            port,
            commandTimeoutMs: 1000,
            reconnectDelayMs: 50,
        });
        client.connect();
        await once(client, 'connect');

        const disconnected = once(client, 'disconnect');
        // Registered after the initial connect has already fired, so the next one is the reconnect.
        const reconnected = once(client, 'connect');

        // Take the display away, as a reboot would.
        await display.stop();
        await disconnected;
        expect(client.isConnected).toBe(false);

        // Bring it back on the same port; the backoff retry must find it unaided.
        display = new MockBraviaDisplay();
        await display.start({ ssipPort: port });
        await reconnected;

        expect(client.isConnected).toBe(true);
        // The recovered connection is fully usable.
        await client.controlChecked('VOLU', encodeNumericParam(7));
        expect(display.volume).toBe(7);
    }, 15000);

    it('times out a command when no answer arrives', async () => {
        await display.stop();
        display = new MockBraviaDisplay({ silentCommands: ['POWR'] });
        await display.start();
        client = new SsipClient({ host: '127.0.0.1', port: display.ssipPort, commandTimeoutMs: 200 });
        client.connect();
        await once(client, 'connect');

        await expect(client.enquire('POWR')).rejects.toMatchObject({ kind: 'retryable' });
        // A timed-out command must not wedge the queue for the next caller.
        await expect(client.enquire('VOLU')).resolves.toMatchObject({ type: 'A', command: 'VOLU' });
    }, 10000);

    it('stops reconnecting once closed', async () => {
        client.connect();
        await once(client, 'connect');
        client.close();
        await waitFor(() => display.ssipClientCount === 0);
        expect(client.isConnected).toBe(false);
    });
});
