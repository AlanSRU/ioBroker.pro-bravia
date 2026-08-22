import type { BraviaRestClient, BraviaService } from '../transport/rest-client';

/**
 * What this particular display can actually do.
 *
 * `guide.getSupportedApiInfo` reports the services, methods and per-method versions the unit
 * implements. Consulting it first means the adapter never creates a state it cannot drive, and
 * never repeatedly calls a method that will always answer `12 No Such Method` — which matters
 * because the professional range differs by model, firmware and EU RED-DA compliance variant.
 */

interface ApiVersionInfo {
    version: string;
    authLevel?: string;
}

interface ApiInfo {
    name: string;
    versions: ApiVersionInfo[];
}

interface ServiceInfo {
    service: string;
    protocols?: string[];
    apis?: ApiInfo[];
}

export class Capabilities {
    /** service -> method -> supported versions, newest first. */
    private readonly methods = new Map<string, Map<string, string[]>>();
    /** Set when the display refused to describe itself and we fell back to assuming support. */
    public readonly assumed: boolean;

    private constructor(services: ServiceInfo[], assumed: boolean) {
        this.assumed = assumed;
        for (const service of services) {
            if (!service || typeof service.service !== 'string') {
                continue;
            }
            const methods = new Map<string, string[]>();
            for (const api of service.apis ?? []) {
                if (!api || typeof api.name !== 'string') {
                    continue;
                }
                const versions = (api.versions ?? [])
                    .map(entry => entry?.version)
                    .filter((version): version is string => typeof version === 'string')
                    .sort(compareVersionsDescending);
                methods.set(api.name, versions.length > 0 ? versions : ['1.0']);
            }
            this.methods.set(service.service, methods);
        }
    }

    /**
     * Ask the display what it supports. Falls back to "assume everything" if it will not say.
     *
     */
    public static async discover(rest: BraviaRestClient): Promise<Capabilities> {
        try {
            const services = await rest.callFirst<ServiceInfo[]>('guide', 'getSupportedApiInfo', [{ services: [] }]);
            if (Array.isArray(services) && services.length > 0) {
                return new Capabilities(services, false);
            }
        } catch {
            // Older or restricted units may not expose the guide service at all.
        }
        return new Capabilities([], true);
    }

    /**
     * Build a fixed capability set. Used by tests and by the "assume everything" fallback.
     *
     */
    public static fromServices(services: ServiceInfo[]): Capabilities {
        return new Capabilities(services, false);
    }

    public hasService(service: BraviaService): boolean {
        return this.assumed || this.methods.has(service);
    }

    public supports(service: BraviaService, method: string): boolean {
        if (this.assumed) {
            return true;
        }
        return this.methods.get(service)?.has(method) ?? false;
    }

    /**
     * Choose which version of a method to call.
     *
     * @param service the endpoint the method belongs to
     * @param method the JSON-RPC method name
     * @param preferred versions in descending order of desirability, e.g. `['1.1', '1.0']`
     * @returns the first preferred version the display supports, or `undefined` if none match
     */
    public pickVersion(service: BraviaService, method: string, preferred: string[]): string | undefined {
        if (this.assumed) {
            return preferred[preferred.length - 1];
        }
        const available = this.methods.get(service)?.get(method);
        if (!available) {
            return undefined;
        }
        return preferred.find(version => available.includes(version));
    }

    public get serviceNames(): string[] {
        return [...this.methods.keys()];
    }
}

/**
 * Compare dotted version strings so `1.10` sorts above `1.9`.
 *
 */
function compareVersionsDescending(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (right[i] ?? 0) - (left[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}
