import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import {
    PARAM_ERROR,
    PARAM_NOT_FOUND,
    PARAM_SUCCESS,
    decodeStream,
    encodeInputParam,
    encodeMessage,
    encodeNumericParam,
    encodeStringParam,
    parseNumericAnswer,
    parseStringAnswer,
} from '../src/transport/ssip-protocol';

/**
 * A mock BRAVIA Professional Display: HTTP JSON-RPC on one port, Simple IP Control on another.
 *
 * Models an FW-85BZ35P closely enough to exercise capability discovery, settings round-trips
 * and SSIP push notifications. Both faces share one state object, so a REST write raises the
 * matching SSIP notify exactly as real hardware does.
 */

/** A JSON-RPC error the mock display should answer with. */
class MockApiError extends Error {
    public constructor(
        public readonly code: number,
        public readonly reason: string,
    ) {
        super(`${code} ${reason}`);
        this.name = 'MockApiError';
    }
}

export interface SettingCandidate {
    value?: string;
    max?: number;
    min?: number;
    step?: number;
}

export interface SettingEntry {
    target: string;
    currentValue: string;
    isAvailable?: boolean;
    candidate?: SettingCandidate[] | null;
}

export interface MockDisplayOptions {
    psk?: string;
    /** Services to advertise via getSupportedApiInfo. Omit one to simulate an unsupported service. */
    services?: string[];
    /** Methods to reject with `12 No Such Method`, to simulate model differences. */
    unsupportedMethods?: string[];
    /** Start powered on. */
    powerOn?: boolean;
    model?: string;
    /** SSIP FourCCs the display accepts but never answers, for exercising command timeouts. */
    silentCommands?: string[];
}

/**
 * What a BRAVIA still answers with the panel in standby. `getPowerStatus` in particular keeps
 * working — that is the whole point of it — so a liveness probe built on it cannot tell standby
 * apart from a fully awake display.
 */
const STANDBY_AVAILABLE = new Set([
    'guide.getSupportedApiInfo',
    'system.getPowerStatus',
    'system.setPowerStatus',
    'system.getSystemInformation',
    'system.getNetworkSettings',
    'system.getInterfaceInformation',
    'system.getSystemSupportedFunction',
    'system.getRemoteControllerInfo',
    'system.getWolMode',
    'system.setWolMode',
    'system.requestReboot',
]);

const numericCandidate = (min: number, max: number, step = 1): SettingCandidate[] => [{ min, max, step }];
const enumCandidate = (...values: string[]): SettingCandidate[] => values.map(value => ({ value }));

export class MockBraviaDisplay {
    private httpServer?: http.Server;
    private ssipServer?: net.Server;
    private ssipSockets = new Set<net.Socket>();
    private ssipBuffers = new WeakMap<net.Socket, Buffer>();

    public httpPort = 0;
    public ssipPort = 0;

    private readonly psk: string;
    private readonly services: string[];
    private readonly unsupportedMethods: Set<string>;
    private readonly model: string;
    private readonly silentCommands: Set<string>;

    /** Every request the mock has served, for assertions about call sequencing. */
    public readonly requests: {
        service: string;
        method: string;
        params: unknown[];
        version: string;
    }[] = [];
    /** Every SSIP frame the mock received, decoded. */
    public readonly ssipRequests: {
        type: string;
        command: string;
        parameter: string;
    }[] = [];

    /** Force one method to keep failing, to exercise repeat-failure handling. */
    public failMethod: string | null = null;
    public power = false;
    public volume = 20;
    public audioMute = false;
    public pictureMute = false;
    public input = { type: 'hdmi' as const, port: 1 };
    public sceneSetting = 'auto';
    public screenRotation = 'off';
    public ledIndicator = { mode: 'Demo', status: 'true' };
    public powerSavingMode = 'off';
    public wolMode = true;

    public pictureSettings: SettingEntry[] = [
        { target: 'color', currentValue: '50', isAvailable: true, candidate: numericCandidate(0, 100) },
        { target: 'brightness', currentValue: '45', isAvailable: true, candidate: numericCandidate(0, 100) },
        { target: 'contrast', currentValue: '90', isAvailable: true, candidate: numericCandidate(0, 100) },
        { target: 'sharpness', currentValue: '30', isAvailable: true, candidate: numericCandidate(0, 100) },
        {
            target: 'pictureMode',
            currentValue: 'standard',
            isAvailable: true,
            candidate: enumCandidate('vivid', 'standard', 'custom', 'cinema', 'game', 'graphics'),
        },
        { target: 'lightSensor', currentValue: 'off', isAvailable: true, candidate: enumCandidate('on', 'off') },
        {
            target: 'colorTemperature',
            currentValue: 'neutral',
            isAvailable: true,
            candidate: enumCandidate('cold', 'neutral', 'warm1', 'warm2'),
        },
        // Present but not applicable to the current input — must still create a state.
        { target: 'hdrMode', currentValue: 'off', isAvailable: false, candidate: enumCandidate('on', 'off') },
        // No candidate list at all — free/derived value.
        { target: 'contentType', currentValue: 'video', isAvailable: true, candidate: null },
    ];

    public speakerSettings: SettingEntry[] = [
        {
            target: 'tvPosition',
            currentValue: 'tableTop',
            isAvailable: true,
            candidate: enumCandidate('tableTop', 'wallMount'),
        },
        { target: 'subwooferLevel', currentValue: '12', isAvailable: true, candidate: numericCandidate(0, 24) },
    ];

    public soundSettings: SettingEntry[] = [
        {
            target: 'outputTerminal',
            currentValue: 'speaker',
            isAvailable: true,
            candidate: enumCandidate('speaker', 'audioSystem'),
        },
    ];

    public applications = [
        { title: 'BRAVIA Signage', uri: 'com.sony.dtv.signage', icon: '' },
        { title: 'Web Browser', uri: 'com.sony.dtv.browser', icon: '' },
    ];

    public constructor(options: MockDisplayOptions = {}) {
        this.psk = options.psk ?? '1234';
        this.services = options.services ?? [
            'guide',
            'system',
            'audio',
            'avContent',
            'video',
            'videoScreen',
            'appControl',
            'encryption',
        ];
        this.unsupportedMethods = new Set(options.unsupportedMethods ?? []);
        this.power = options.powerOn ?? true;
        this.model = options.model ?? 'FW-85BZ35P';
        this.silentCommands = new Set(options.silentCommands ?? []);
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * Bind both faces. Pass explicit ports to rebind the same addresses after a `stop()`,
     * which is what the reconnect tests need.
     */
    public async start(
        ports: {
            httpPort?: number;
            ssipPort?: number;
        } = {},
    ): Promise<void> {
        await this.startHttp(ports.httpPort ?? 0);
        await this.startSsip(ports.ssipPort ?? 0);
    }

    public async stop(): Promise<void> {
        for (const socket of this.ssipSockets) {
            socket.destroy();
        }
        this.ssipSockets.clear();
        await Promise.all([
            new Promise<void>(resolve => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve())),
            new Promise<void>(resolve => (this.ssipServer ? this.ssipServer.close(() => resolve()) : resolve())),
        ]);
    }

    private startHttp(port: number): Promise<void> {
        return new Promise(resolve => {
            this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
            this.httpServer.listen(port, '127.0.0.1', () => {
                this.httpPort = (this.httpServer!.address() as AddressInfo).port;
                resolve();
            });
        });
    }

    private startSsip(port: number): Promise<void> {
        return new Promise(resolve => {
            this.ssipServer = net.createServer(socket => this.handleSsipConnection(socket));
            this.ssipServer.listen(port, '127.0.0.1', () => {
                this.ssipPort = (this.ssipServer!.address() as AddressInfo).port;
                resolve();
            });
        });
    }

    // ---------------------------------------------------------------- HTTP face

    private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const service = (req.url ?? '').replace(/^\/sony\//, '');
            let body: {
                method?: string;
                id?: number;
                params?: unknown[];
                version?: string;
            };
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return this.sendJson(res, 200, { error: [5, 'Illegal Request'], id: 0 });
            }

            const id = body.id ?? 0;

            if (req.headers['x-auth-psk'] !== this.psk) {
                return this.sendJson(res, 403, { error: [403, 'Forbidden'], id });
            }
            if (service === 'ircc') {
                return this.handleIrcc(res);
            }
            if (!this.services.includes(service)) {
                return this.sendJson(res, 404, { error: [404, 'Not Found'], id });
            }

            const method = body.method ?? '';
            const params = body.params ?? [];
            const version = body.version ?? '1.0';
            this.requests.push({ service, method, params, version });

            if (this.unsupportedMethods.has(method)) {
                return this.sendJson(res, 200, { error: [12, 'No Such Method'], id });
            }
            if (this.failMethod === method) {
                return this.sendJson(res, 200, { error: [7, 'Illegal State'], id });
            }

            try {
                const result = this.dispatch(service, method, params);
                if (result === undefined) {
                    return this.sendJson(res, 200, { error: [12, 'No Such Method'], id });
                }
                this.sendJson(res, 200, { result, id });
            } catch (e) {
                const error = e as MockApiError;
                this.sendJson(res, 200, { error: [error.code, error.reason], id });
            }
        });
    }

    private handleIrcc(res: http.ServerResponse): void {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=UTF-8' });
        res.end(
            '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
                '<s:Body><u:X_SendIRCCResponse xmlns:u="urn:schemas-sony-com:service:IRCC:1"/></s:Body></s:Envelope>',
        );
    }

    private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    }

    /**
     * Returns the `result` payload, or `undefined` for an unknown method.
     *
     */
    private dispatch(service: string, method: string, params: unknown[]): unknown {
        const arg = (params[0] ?? {}) as Record<string, unknown>;

        // In standby the panel answers only the system-level basics; everything to do with
        // audio, video, inputs and apps is refused with 40005. Modelling this matters: an
        // adapter that starts while the display is off sees empty discovery, not a failure.
        if (!this.power && !STANDBY_AVAILABLE.has(`${service}.${method}`)) {
            throw new MockApiError(40005, 'Display is turned off');
        }

        switch (`${service}.${method}`) {
            case 'guide.getSupportedApiInfo':
                return [this.supportedApiInfo()];

            case 'system.getSystemInformation':
                return [
                    {
                        product: 'TV',
                        region: '',
                        language: 'eng',
                        model: this.model,
                        serial: '1000001',
                        macAddr: '12:34:56:78:9A:BC',
                        name: 'BRAVIA',
                        generation: '5.0.0',
                        area: 'ZZZ',
                        cid: '01234567890123456789012345678901',
                    },
                ];
            case 'system.getPowerStatus':
                return [{ status: this.power ? 'active' : 'standby' }];
            case 'system.setPowerStatus':
                this.setPower(Boolean(arg.status));
                return [];
            case 'system.getLEDIndicatorStatus':
                return [this.ledIndicator];
            case 'system.setLEDIndicatorStatus':
                this.ledIndicator = { mode: String(arg.mode), status: String(arg.status) };
                return [];
            case 'system.getPowerSavingMode':
                return [{ mode: this.powerSavingMode }];
            case 'system.setPowerSavingMode':
                this.powerSavingMode = String(arg.mode);
                return [];
            case 'system.getWolMode':
                return [{ enabled: this.wolMode }];
            case 'system.setWolMode':
                this.wolMode = Boolean(arg.enabled);
                return [];
            case 'system.getCurrentTime':
                return ['2026-08-21T18:00:00+0100'];
            case 'system.getNetworkSettings':
                return [
                    [
                        {
                            netif: 'eth0',
                            ipAddrV4: '192.168.0.14',
                            hwAddr: '12:34:56:78:9A:BC',
                            netmask: '255.255.255.0',
                            gateway: '192.168.0.1',
                            dns: ['192.168.0.1'],
                        },
                    ],
                ];
            case 'system.getInterfaceInformation':
                return [
                    {
                        productCategory: 'tv',
                        productName: 'BRAVIA',
                        modelName: this.model,
                        serverName: '',
                        interfaceVersion: '5.0.0',
                    },
                ];
            case 'system.getRemoteControllerInfo':
                return [
                    { bundled: true, type: 'RM-XXXXX' },
                    [
                        { name: 'PowerOff', value: 'AAAAAQAAAAEAAAAvAw==' },
                        { name: 'Input', value: 'AAAAAQAAAAEAAAAlAw==' },
                        { name: 'Hdmi1', value: 'AAAAAgAAABoAAABaAw==' },
                        { name: 'Home', value: 'AAAAAQAAAAEAAABgAw==' },
                        { name: 'Up', value: 'AAAAAQAAAAEAAAB0Aw==' },
                    ],
                ];
            case 'system.getSystemSupportedFunction':
                return [[{ option: 'WOL', value: '12:34:56:78:9A:BC' }]];
            case 'system.requestReboot':
                return [];

            case 'audio.getVolumeInformation':
                return [
                    [
                        { target: 'speaker', volume: this.volume, mute: this.audioMute, maxVolume: 100, minVolume: 0 },
                        { target: 'headphone', volume: 15, mute: false, maxVolume: 100, minVolume: 0 },
                    ],
                ];
            case 'audio.setAudioVolume': {
                const target = typeof arg.target === 'string' && arg.target !== '' ? arg.target : 'speaker';
                if (target === 'speaker') {
                    this.setVolume(this.applyVolume(String(arg.volume)));
                }
                return [];
            }
            case 'audio.setAudioMute':
                this.setAudioMute(Boolean(arg.status));
                return [];
            case 'audio.getSpeakerSettings':
                return [this.filterSettings(this.speakerSettings, arg.target)];
            case 'audio.setSpeakerSettings':
                this.applySettings(this.speakerSettings, arg.settings);
                return [];
            case 'audio.getSoundSettings':
                return [this.filterSettings(this.soundSettings, arg.target)];
            case 'audio.setSoundSettings':
                this.applySettings(this.soundSettings, arg.settings);
                return [];

            case 'avContent.getCurrentExternalInputsStatus':
                return [
                    [
                        {
                            uri: 'extInput:hdmi?port=1',
                            title: 'HDMI 1',
                            connection: true,
                            label: 'Playout PC',
                            icon: 'meta:hdmi',
                            status: '',
                        },
                        {
                            uri: 'extInput:hdmi?port=2',
                            title: 'HDMI 2',
                            connection: false,
                            label: '',
                            icon: 'meta:hdmi',
                            status: '',
                        },
                        {
                            uri: 'extInput:hdmi?port=3',
                            title: 'HDMI 3',
                            connection: false,
                            label: '',
                            icon: 'meta:hdmi',
                            status: '',
                        },
                    ],
                ];
            case 'avContent.getPlayingContentInfo':
                return [
                    {
                        uri: `extInput:hdmi?port=${this.input.port}`,
                        title: `HDMI ${this.input.port}`,
                        source: 'extInput:hdmi',
                    },
                ];
            case 'avContent.setPlayContent': {
                const match = /^extInput:hdmi\?port=(\d+)$/.exec(String(arg.uri));
                if (!match) {
                    throw new MockApiError(41001, 'Content does Not Exist');
                }
                this.setInput(Number(match[1]));
                return [];
            }
            case 'avContent.getSchemeList':
                return [[{ scheme: 'extInput' }, { scheme: 'fav' }]];
            case 'avContent.getSourceList':
                return [[{ source: 'extInput:hdmi' }, { source: 'extInput:component' }]];

            case 'video.getPictureQualitySettings':
                return [this.filterSettings(this.pictureSettings, arg.target)];
            case 'video.setPictureQualitySettings':
                this.applySettings(this.pictureSettings, arg.settings);
                return [];
            case 'video.getScreenRotation':
                return [{ rotation: this.screenRotation }];
            case 'video.setScreenRotation':
                this.screenRotation = String(arg.rotation);
                return [];

            case 'videoScreen.getSceneSetting':
                return [{ currentValue: this.sceneSetting, candidate: ['auto', 'auto24pSync', 'general'] }];
            case 'videoScreen.setSceneSetting':
                this.sceneSetting = String(arg.value);
                return [];

            case 'appControl.getApplicationList':
                return [this.applications];
            case 'appControl.getApplicationStatusList':
                return [[{ name: 'textInput', status: 'off' }]];
            case 'appControl.setActiveApp':
                return [];
            case 'appControl.terminateApps':
                return [];

            case 'encryption.getPublicKey':
                return [{ publicKey: 'MOCKPUBLICKEY' }];

            default:
                return undefined;
        }
    }

    private applyVolume(raw: string): number {
        // The real display accepts absolute ("25") and relative ("+1"/"-1") forms.
        if (raw.startsWith('+') || raw.startsWith('-')) {
            return Math.max(0, Math.min(100, this.volume + Number(raw)));
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
            throw new MockApiError(40801, 'Volume Out of Range');
        }
        return value;
    }

    private filterSettings(settings: SettingEntry[], target: unknown): SettingEntry[] {
        const name = typeof target === 'string' ? target : '';
        return name ? settings.filter(entry => entry.target === name) : settings;
    }

    private applySettings(settings: SettingEntry[], raw: unknown): void {
        const list = Array.isArray(raw)
            ? (raw as {
                  target: string;
                  value: string;
              }[])
            : [];
        let failed = false;
        for (const { target, value } of list) {
            const entry = settings.find(candidate => candidate.target === target);
            if (!entry) {
                failed = true;
                continue;
            }
            entry.currentValue = value;
        }
        if (failed) {
            throw new MockApiError(40004, 'Multiple Settings Failed');
        }
    }

    private supportedApiInfo(): unknown {
        const apis: Record<string, string[]> = {
            guide: ['getSupportedApiInfo'],
            system: [
                'getSystemInformation',
                'getPowerStatus',
                'setPowerStatus',
                'getLEDIndicatorStatus',
                'setLEDIndicatorStatus',
                'getPowerSavingMode',
                'setPowerSavingMode',
                'getWolMode',
                'setWolMode',
                'getCurrentTime',
                'getNetworkSettings',
                'getInterfaceInformation',
                'getRemoteControllerInfo',
                'getSystemSupportedFunction',
                'requestReboot',
            ],
            audio: [
                'getVolumeInformation',
                'setAudioVolume',
                'setAudioMute',
                'getSpeakerSettings',
                'setSpeakerSettings',
                'getSoundSettings',
                'setSoundSettings',
            ],
            avContent: [
                'getCurrentExternalInputsStatus',
                'getPlayingContentInfo',
                'setPlayContent',
                'getSchemeList',
                'getSourceList',
            ],
            video: ['getPictureQualitySettings', 'setPictureQualitySettings', 'getScreenRotation', 'setScreenRotation'],
            videoScreen: ['getSceneSetting', 'setSceneSetting'],
            appControl: ['getApplicationList', 'getApplicationStatusList', 'setActiveApp', 'terminateApps'],
            encryption: ['getPublicKey'],
        };

        return this.services.map(service => ({
            service,
            protocols: ['xhrpost:jsonizer'],
            apis: (apis[service] ?? [])
                .filter(name => !this.unsupportedMethods.has(name))
                .map(name => ({ name, versions: [{ version: '1.0' }] })),
        }));
    }

    // ---------------------------------------------------------------- SSIP face

    private handleSsipConnection(socket: net.Socket): void {
        this.ssipSockets.add(socket);
        this.ssipBuffers.set(socket, Buffer.alloc(0));

        socket.on('data', chunk => {
            const buffered = Buffer.concat([this.ssipBuffers.get(socket) ?? Buffer.alloc(0), chunk]);
            const { messages, rest } = decodeStream(buffered);
            this.ssipBuffers.set(socket, rest);
            for (const message of messages) {
                this.ssipRequests.push(message);
                if (this.silentCommands.has(message.command)) {
                    continue;
                }
                const answer = this.handleSsipMessage(message.type, message.command, message.parameter);
                if (answer) {
                    socket.write(answer);
                }
            }
        });

        socket.on('error', () => undefined);
        socket.on('close', () => this.ssipSockets.delete(socket));
    }

    private handleSsipMessage(type: string, command: string, parameter: string): Buffer | null {
        const ok = encodeMessage('A', command, PARAM_SUCCESS);
        const err = encodeMessage('A', command, PARAM_ERROR);
        const answer = (value: string): Buffer => encodeMessage('A', command, value);

        if (type === 'E') {
            switch (command) {
                case 'POWR':
                    return answer(encodeNumericParam(this.power ? 1 : 0));
                case 'VOLU':
                    return answer(encodeNumericParam(this.volume));
                case 'AMUT':
                    return answer(encodeNumericParam(this.audioMute ? 1 : 0));
                case 'PMUT':
                    return answer(encodeNumericParam(this.pictureMute ? 1 : 0));
                case 'INPT':
                    return answer(encodeInputParam(this.input.type, this.input.port));
                case 'SCEN':
                    return answer(encodeStringParam(this.sceneSetting));
                case 'MADR':
                    return answer(encodeStringParam('123456789ABC'));
                case 'BADR':
                    return answer(encodeStringParam('192.168.0.255'));
                default:
                    return err;
            }
        }

        if (type === 'C') {
            switch (command) {
                case 'POWR':
                    this.setPower(parseNumericAnswer(parameter) === 1);
                    return ok;
                case 'TPOW':
                    this.setPower(!this.power);
                    return ok;
                case 'VOLU': {
                    const value = parseNumericAnswer(parameter);
                    if (value === null || value > 100) {
                        return err;
                    }
                    this.setVolume(value);
                    return ok;
                }
                case 'AMUT':
                    this.setAudioMute(parseNumericAnswer(parameter) === 1);
                    return ok;
                case 'PMUT':
                    this.setPictureMute(parseNumericAnswer(parameter) === 1);
                    return ok;
                case 'TPMU':
                    this.setPictureMute(!this.pictureMute);
                    return ok;
                case 'INPT': {
                    const port = Number(parameter.slice(8));
                    if (Number(parameter.slice(0, 8)) !== 1 || port < 1 || port > 3) {
                        return encodeMessage('A', command, PARAM_NOT_FOUND);
                    }
                    this.setInput(port);
                    return ok;
                }
                case 'SCEN': {
                    const value = parseStringAnswer(parameter);
                    if (!value || !['auto', 'auto24pSync', 'general'].includes(value)) {
                        return encodeMessage('A', command, PARAM_NOT_FOUND);
                    }
                    this.sceneSetting = value;
                    return ok;
                }
                case 'IRCC':
                    return parseNumericAnswer(parameter) === null ? err : ok;
                default:
                    return err;
            }
        }

        return err;
    }

    /**
     * Push an unsolicited Notify frame to every connected SSIP client.
     *
     */
    public notify(command: string, parameter: string): void {
        const frame = encodeMessage('N', command, parameter);
        for (const socket of this.ssipSockets) {
            socket.write(frame);
        }
    }

    // ------------------------------------------------- state mutators (+ notify)

    public setPower(on: boolean): void {
        this.power = on;
        this.notify('POWR', encodeNumericParam(on ? 1 : 0));
    }

    public setVolume(value: number): void {
        this.volume = value;
        this.notify('VOLU', encodeNumericParam(value));
    }

    public setAudioMute(muted: boolean): void {
        this.audioMute = muted;
        this.notify('AMUT', encodeNumericParam(muted ? 1 : 0));
    }

    public setPictureMute(muted: boolean): void {
        this.pictureMute = muted;
        this.notify('PMUT', encodeNumericParam(muted ? 1 : 0));
    }

    public setInput(port: number): void {
        this.input = { type: 'hdmi', port };
        this.notify('INPT', encodeInputParam('hdmi', port));
    }

    /** Number of currently connected SSIP clients. */
    public get ssipClientCount(): number {
        return this.ssipSockets.size;
    }
}
