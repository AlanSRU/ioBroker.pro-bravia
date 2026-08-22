import * as dgram from 'node:dgram';

import { BraviaError } from '../lib/errors';
import { type TimerApi, delay as wait } from '../lib/timers';

/**
 * Wake-on-LAN. A suspended display stops its HTTP server entirely, so neither REST nor IRCC can
 * reach it — a magic packet is the only way back. Sony recommends sending several.
 */

const WOL_PORT = 9;
const DEFAULT_BROADCAST = '255.255.255.255';

/**
 * Accepts `00:11:22:33:44:55`, `00-11-22-33-44-55` or `001122334455`.
 *
 */
export function parseMacAddress(mac: string): Buffer {
    const hex = mac.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 12) {
        throw new BraviaError(`Invalid MAC address "${mac}"`, 'badRequest');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * 6 × 0xFF followed by the MAC repeated 16 times.
 *
 */
export function buildMagicPacket(mac: string): Buffer {
    const address = parseMacAddress(mac);
    return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(address)]);
}

export interface WakeOptions {
    /** Subnet broadcast address. Prefer the display's own, via SSIP `BADR`. */
    broadcastAddress?: string;
    port?: number;
    /** Sony advises repeating the packet; a suspended panel can miss the first. */
    repeat?: number;
    repeatDelayMs?: number;
    /** Framework timers, so the inter-packet wait is owned by the adapter. */
    timers?: TimerApi;
}

export async function wake(mac: string, options: WakeOptions = {}): Promise<void> {
    const packet = buildMagicPacket(mac);
    const address = options.broadcastAddress || DEFAULT_BROADCAST;
    const port = options.port ?? WOL_PORT;
    const repeat = Math.max(1, options.repeat ?? 3);
    const delayMs = options.repeatDelayMs ?? 100;

    const socket = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(() => {
                try {
                    socket.setBroadcast(true);
                    resolve();
                } catch (e) {
                    reject(e instanceof Error ? e : new Error(String(e)));
                }
            });
        });

        for (let attempt = 0; attempt < repeat; attempt++) {
            await new Promise<void>((resolve, reject) => {
                socket.send(packet, port, address, error => (error ? reject(error) : resolve()));
            });
            if (attempt < repeat - 1) {
                await wait(delayMs, options.timers);
            }
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new BraviaError(`Wake-on-LAN to ${address}: ${message}`, 'transport');
    } finally {
        socket.close();
    }
}
