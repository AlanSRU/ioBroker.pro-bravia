// Instance configuration, mirroring `native` in io-package.json and admin/jsonConfig.json.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Display IP address or hostname. */
            host: string;
            /** Pre-shared key configured on the display (stored encrypted). */
            psk: string;
            /** HTTP port serving the REST and IRCC endpoints. */
            httpPort: number;
            /** Per-request timeout, in seconds. */
            requestTimeout: number;
            /** How often to re-read values the display cannot push, in seconds. */
            pollInterval: number;
            /** Hold a Simple IP Control connection for push notifications. */
            useSsip: boolean;
            ssipPort: number;
            /** Expose remote-control key emulation over IRCC-IP. */
            useIrcc: boolean;
            /** MAC address for Wake-on-LAN; read from the display when left blank. */
            macAddress: string;
            /** Subnet broadcast address for Wake-on-LAN; read from the display when left blank. */
            broadcastAddress: string;
        }
    }
}

export {};
