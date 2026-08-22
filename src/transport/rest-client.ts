import axios, { type AxiosInstance } from 'axios';

import { BraviaError, classifyErrorCode } from '../lib/errors';

/**
 * JSON-RPC client for the BRAVIA Professional Display REST API.
 *
 * Every service lives at `POST http://{host}/sony/{service}` and authenticates with the
 * `X-Auth-PSK` header. Requests are serialised: the display answers `40003 Request Duplicated`
 * if a second call arrives while the first is still outstanding.
 */

export type BraviaService =
    'guide' | 'system' | 'audio' | 'avContent' | 'video' | 'videoScreen' | 'appControl' | 'encryption';

export interface RestClientOptions {
    host: string;
    psk: string;
    /** HTTP port. Displays serve the API on 80; configurable for proxies. */
    port?: number;
    timeoutMs?: number;
}

/** Highest legal JSON-RPC id — Sony reserves 0 and caps at 2^31-1. */
const MAX_REQUEST_ID = 2147483647;

interface JsonRpcResponse<T> {
    result?: T;
    error?: [number, string];
    id?: number;
}

export class BraviaRestClient {
    private readonly http: AxiosInstance;
    private readonly host: string;
    private requestId = 0;
    /** Tail of the serialisation chain; each call awaits the previous one. */
    private queue: Promise<unknown> = Promise.resolve();

    public constructor(options: RestClientOptions) {
        this.host = options.host;
        this.http = axios.create({
            baseURL: `http://${options.host}${options.port && options.port !== 80 ? `:${options.port}` : ''}/sony`,
            timeout: options.timeoutMs ?? 5000,
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Auth-PSK': options.psk,
            },
            // The display answers 403/503 with a JSON-RPC body we want to read ourselves.
            validateStatus: () => true,
        });
    }

    private nextId(): number {
        this.requestId = this.requestId >= MAX_REQUEST_ID ? 1 : this.requestId + 1;
        return this.requestId;
    }

    /**
     * Call one API method. Rejects with a {@link BraviaError} carrying the classified failure kind.
     *
     * @param service endpoint segment, e.g. `system`
     * @param method  JSON-RPC method name, e.g. `getPowerStatus`
     * @param params  params array contents; most methods take `[]` or `[{...}]`
     * @param version API-specific version string, e.g. `1.0`
     */
    public call<T = unknown>(
        service: BraviaService,
        method: string,
        params: unknown[] = [],
        version = '1.0',
    ): Promise<T> {
        const run = (): Promise<T> => this.execute<T>(service, method, params, version);
        // Chain onto the queue but never let one failure poison the next caller.
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async execute<T>(service: BraviaService, method: string, params: unknown[], version: string): Promise<T> {
        const context = `${service}.${method}`;
        const id = this.nextId();

        let response;
        try {
            response = await this.http.post<JsonRpcResponse<T>>(`/${service}`, {
                method,
                id,
                params,
                version,
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new BraviaError(`${context}: ${message}`, 'transport', undefined, context);
        }

        const body = response.data;

        // A JSON-RPC error body is authoritative even when it arrives with a non-200 status.
        if (body && Array.isArray(body.error)) {
            const [code, description] = body.error;
            throw new BraviaError(`${context}: ${description} (${code})`, classifyErrorCode(code), code, context);
        }

        if (response.status !== 200) {
            throw new BraviaError(
                `${context}: HTTP ${response.status}`,
                classifyErrorCode(response.status),
                response.status,
                context,
            );
        }

        if (!body || body.result === undefined) {
            throw new BraviaError(`${context}: malformed response, no result field`, 'unknown', undefined, context);
        }

        return body.result;
    }

    /**
     * Most methods wrap their payload in a single-element `result` array
     * (`{"result": [{...}]}`), so unwrap that first element.
     *
     */
    public async callFirst<T>(
        service: BraviaService,
        method: string,
        params: unknown[] = [],
        version = '1.0',
    ): Promise<T> {
        const result = await this.call<T[]>(service, method, params, version);
        if (!Array.isArray(result) || result.length === 0) {
            throw new BraviaError(
                `${service}.${method}: expected a non-empty result array`,
                'unknown',
                undefined,
                `${service}.${method}`,
            );
        }
        return result[0];
    }

    public get address(): string {
        return this.host;
    }
}
