import axios, { type AxiosInstance } from 'axios';

import { BraviaError, classifyErrorCode } from '../lib/errors';

/**
 * IRCC-IP transport: infrared remote emulation over SOAP.
 *
 * `POST /sony/ircc` with the `X_SendIRCC` SOAP action and a base64 IRCC code. The code table is
 * per-model and is read from the display itself via the REST `system.getRemoteControllerInfo`
 * method, so nothing is hardcoded here.
 */

const SOAP_ACTION = '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"';

export interface IrccClientOptions {
    host: string;
    psk: string;
    port?: number;
    timeoutMs?: number;
}

/** One entry of the display's own remote-control code table. */
export interface RemoteControllerKey {
    name: string;
    value: string;
}

const escapeXml = (value: string): string =>
    value.replace(
        /[<>&'"]/g,
        char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!,
    );

export class BraviaIrccClient {
    private readonly http: AxiosInstance;
    private queue: Promise<unknown> = Promise.resolve();

    public constructor(options: IrccClientOptions) {
        this.http = axios.create({
            baseURL: `http://${options.host}${options.port && options.port !== 80 ? `:${options.port}` : ''}`,
            timeout: options.timeoutMs ?? 5000,
            headers: {
                'Content-Type': 'text/xml; charset=UTF-8',
                SOAPACTION: SOAP_ACTION,
                'X-Auth-PSK': options.psk,
            },
            validateStatus: () => true,
        });
    }

    /**
     * Send one base64 IRCC code. Resolves once the display has accepted it.
     *
     */
    public send(code: string): Promise<void> {
        const run = (): Promise<void> => this.execute(code);
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async execute(code: string): Promise<void> {
        const envelope =
            '<?xml version="1.0"?>' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body>' +
            '<u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">' +
            `<IRCCCode>${escapeXml(code)}</IRCCCode>` +
            '</u:X_SendIRCC>' +
            '</s:Body></s:Envelope>';

        let response;
        try {
            response = await this.http.post('/sony/ircc', envelope);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new BraviaError(`IRCC ${code}: ${message}`, 'transport', undefined, 'ircc');
        }

        if (response.status !== 200) {
            throw new BraviaError(
                `IRCC ${code}: HTTP ${response.status}`,
                classifyErrorCode(response.status),
                response.status,
                'ircc',
            );
        }
    }
}
