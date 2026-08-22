import { BraviaError } from '../lib/errors';
import { SSIP_COMMANDS, encodeNumericParam, parseNumericAnswer, type SsipMessage } from '../transport/ssip-protocol';
import { wake } from '../transport/wol';
import type { DeviceContext, FeatureModule } from './types';

/**
 * Power control and system-level settings.
 *
 * Power is the one area where all four transports matter: REST reports and sets it, SSIP pushes
 * changes instantly, and Wake-on-LAN is the only way back from a suspended panel — a display in
 * suspend stops its HTTP server, so `setPowerStatus(true)` cannot reach it.
 */

interface SystemInformation {
    model?: string;
    serial?: string;
    macAddr?: string;
    name?: string;
    generation?: string;
    area?: string;
    product?: string;
}

interface NetworkInterface {
    netif?: string;
    ipAddrV4?: string;
    hwAddr?: string;
}

const LED_MODES = ['Demo', 'AutoBrightnessAdjust', 'Dark', 'SimpleResponse', 'Off'];
const POWER_SAVING_MODES = ['off', 'low', 'high', 'pictureOff'];

export class SystemModule implements FeatureModule {
    public readonly root = 'power';
    public readonly name = 'system';

    private macAddress?: string;
    private broadcastAddress?: string;

    public constructor(private readonly ctx: DeviceContext) {}

    public async init(): Promise<void> {
        const { store, capabilities } = this.ctx;

        await store.ensureChannel('info', 'Device information');
        await store.ensureState('info.model', {
            name: 'Model',
            type: 'string',
            role: 'info.name',
            read: true,
            write: false,
        });
        await store.ensureState('info.serial', {
            name: 'Serial number',
            type: 'string',
            role: 'info.serial',
            read: true,
            write: false,
        });
        await store.ensureState('info.macAddress', {
            name: 'MAC address',
            type: 'string',
            role: 'info.mac',
            read: true,
            write: false,
        });
        await store.ensureState('info.ipAddress', {
            name: 'IP address',
            type: 'string',
            role: 'info.ip',
            read: true,
            write: false,
        });
        await store.ensureState('info.generation', {
            name: 'REST API generation',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await store.ensureState('info.deviceName', {
            name: 'Device name',
            type: 'string',
            role: 'info.name',
            read: true,
            write: false,
        });
        // info.connection, info.ssipConnection and info.lastError are declared as
        // instanceObjects in io-package.json, so they exist before the SSIP socket can connect.

        await store.ensureChannel('power', 'Power');
        await store.ensureState('power.state', {
            name: 'Power',
            type: 'boolean',
            role: 'switch.power',
            read: true,
            write: true,
        });
        await store.ensureState('power.status', {
            name: 'Power status',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });

        // Toggling needs SSIP: the REST API has no toggle, and a display in standby cannot be
        // asked what state it is in over HTTP.
        if (this.ctx.ssip) {
            await store.ensureState('power.toggle', {
                name: 'Toggle power',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
        }

        if (capabilities.supports('system', 'requestReboot')) {
            await store.ensureState('power.reboot', {
                name: 'Reboot display',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
        }

        await store.ensureState('power.wake', {
            name: 'Wake on LAN',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
        });

        await store.ensureChannel('system', 'System settings');
        if (capabilities.supports('system', 'setPowerSavingMode')) {
            await store.ensureState('system.powerSavingMode', {
                name: 'Power saving mode',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                states: Object.fromEntries(POWER_SAVING_MODES.map(mode => [mode, mode])),
            });
        } else if (capabilities.supports('system', 'getPowerSavingMode')) {
            await store.ensureState('system.powerSavingMode', {
                name: 'Power saving mode',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            });
        }

        if (capabilities.supports('system', 'getWolMode')) {
            const writable = capabilities.supports('system', 'setWolMode');
            await store.ensureState('system.wolMode', {
                name: 'Wake-on-LAN enabled',
                type: 'boolean',
                // `switch` is defined as writable; a read-only boolean must be an `indicator`.
                role: writable ? 'switch' : 'indicator',
                read: true,
                write: writable,
            });
        }

        if (capabilities.supports('system', 'getLEDIndicatorStatus')) {
            const writable = capabilities.supports('system', 'setLEDIndicatorStatus');
            await store.ensureChannel('system.led', 'LED indicator');
            await store.ensureState('system.led.mode', {
                name: 'LED indicator mode',
                type: 'string',
                role: 'text',
                read: true,
                write: writable,
                states: Object.fromEntries(LED_MODES.map(mode => [mode, mode])),
            });
            await store.ensureState('system.led.status', {
                name: 'LED indicator on',
                type: 'boolean',
                role: writable ? 'switch' : 'indicator',
                read: true,
                write: writable,
            });
        }

        if (capabilities.supports('system', 'getCurrentTime')) {
            await store.ensureState('system.currentTime', {
                name: 'Display clock',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            });
        }

        await this.readSystemInformation();
    }

    /** Static identity, read once at startup — it cannot change while the adapter runs. */
    private async readSystemInformation(): Promise<void> {
        const { rest, store, capabilities } = this.ctx;

        if (capabilities.supports('system', 'getSystemInformation')) {
            const version = capabilities.pickVersion('system', 'getSystemInformation', ['1.7', '1.0']) ?? '1.0';
            try {
                const info = await rest.callFirst<SystemInformation>('system', 'getSystemInformation', [], version);
                await store.setAck('info.model', info.model ?? '');
                await store.setAck('info.serial', info.serial ?? '');
                await store.setAck('info.deviceName', info.name ?? '');
                await store.setAck('info.generation', info.generation ?? '');
                if (info.macAddr) {
                    this.macAddress = info.macAddr;
                    await store.setAck('info.macAddress', info.macAddr);
                }
            } catch (e) {
                this.ctx.reportError(e, 'system.getSystemInformation');
            }
        }

        if (capabilities.supports('system', 'getNetworkSettings')) {
            try {
                const interfaces = await rest.call<NetworkInterface[][]>('system', 'getNetworkSettings', [
                    { netif: '' },
                ]);
                const first = interfaces?.[0]?.[0];
                if (first?.ipAddrV4) {
                    await store.setAck('info.ipAddress', first.ipAddrV4);
                }
                if (!this.macAddress && first?.hwAddr) {
                    this.macAddress = first.hwAddr;
                    await store.setAck('info.macAddress', first.hwAddr);
                }
            } catch (e) {
                this.ctx.reportError(e, 'system.getNetworkSettings');
            }
        }

        // The display knows its own subnet broadcast address; using it beats 255.255.255.255,
        // which many networks drop.
        if (this.ctx.ssip?.isConnected) {
            try {
                const answer = await this.ctx.ssip.enquire(SSIP_COMMANDS.broadcastAddress, 'eth0############');
                const address = answer.parameter.replace(/#+$/, '');
                if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
                    this.broadcastAddress = address;
                }
            } catch {
                // Optional refinement only — Wake-on-LAN still works against the global broadcast.
            }
        }
    }

    public async refresh(): Promise<void> {
        const { rest, store, capabilities } = this.ctx;

        if (capabilities.supports('system', 'getPowerStatus')) {
            try {
                const { status } = await rest.callFirst<{
                    status: string;
                }>('system', 'getPowerStatus');
                await store.setAck('power.status', status);
                await store.setAck('power.state', status === 'active');
            } catch (e) {
                this.ctx.reportError(e, 'system.getPowerStatus');
            }
        }

        // Everything below is refused while the panel is off, so do not even ask.
        if ((await store.getValue('power.state')) !== true) {
            return;
        }

        if (capabilities.supports('system', 'getPowerSavingMode')) {
            await this.readInto('system.powerSavingMode', async () => {
                const { mode } = await rest.callFirst<{
                    mode: string;
                }>('system', 'getPowerSavingMode');
                return mode;
            });
        }

        if (capabilities.supports('system', 'getWolMode')) {
            await this.readInto('system.wolMode', async () => {
                const { enabled } = await rest.callFirst<{
                    enabled: boolean;
                }>('system', 'getWolMode');
                return enabled;
            });
        }

        if (capabilities.supports('system', 'getLEDIndicatorStatus')) {
            try {
                const led = await rest.callFirst<{
                    mode?: string;
                    status?: string;
                }>('system', 'getLEDIndicatorStatus');
                await store.setAck('system.led.mode', led.mode ?? '');
                // `status` is a *string* "true"/"false", and null means "unknown".
                if (led.status === 'true' || led.status === 'false') {
                    await store.setAck('system.led.status', led.status === 'true');
                }
            } catch (e) {
                this.ctx.reportError(e, 'system.getLEDIndicatorStatus');
            }
        }

        if (capabilities.supports('system', 'getCurrentTime')) {
            await this.readInto('system.currentTime', async () => {
                const version = capabilities.pickVersion('system', 'getCurrentTime', ['1.1', '1.0']) ?? '1.0';
                const result = await rest.call<unknown[]>('system', 'getCurrentTime', [], version);
                const value = result[0];
                return typeof value === 'string'
                    ? value
                    : ((
                          value as {
                              dateTime?: string;
                          }
                      )?.dateTime ?? '');
            });
        }
    }

    private async readInto(id: string, read: () => Promise<ioBroker.StateValue>): Promise<void> {
        try {
            await this.ctx.store.setAck(id, await read());
        } catch (e) {
            this.ctx.reportError(e, id);
        }
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        const { rest } = this.ctx;

        switch (path) {
            case 'state':
                await this.setPower(Boolean(value));
                return true;

            case 'toggle':
                if (this.ctx.ssip) {
                    await this.ctx.ssip.controlChecked(SSIP_COMMANDS.togglePower);
                    return true;
                }
                return false;

            case 'reboot':
                await rest.call('system', 'requestReboot');
                return true;

            case 'wake':
                await this.wakeDisplay();
                return true;

            default:
                return false;
        }
    }

    /**
     * Writes routed here from the `system` root, which this module also owns.
     *
     */
    public async writeSystem(path: string, value: ioBroker.StateValue): Promise<boolean> {
        const { rest, store } = this.ctx;

        switch (path) {
            case 'powerSavingMode':
                await rest.call('system', 'setPowerSavingMode', [{ mode: String(value) }]);
                await store.setAck('system.powerSavingMode', value);
                return true;

            case 'wolMode':
                await rest.call('system', 'setWolMode', [{ enabled: Boolean(value) }]);
                await store.setAck('system.wolMode', Boolean(value));
                return true;

            case 'led.mode':
            case 'led.status': {
                const version =
                    this.ctx.capabilities.pickVersion('system', 'setLEDIndicatorStatus', ['1.1', '1.0']) ?? '1.1';
                // Both halves must be sent together, so read the other one back from the store.
                const mode =
                    path === 'led.mode' ? String(value) : String((await store.getValue('system.led.mode')) ?? 'Demo');
                const on =
                    path === 'led.status' ? Boolean(value) : (await store.getValue('system.led.status')) === true;
                await rest.call('system', 'setLEDIndicatorStatus', [{ mode, status: on ? 'true' : 'false' }], version);
                await store.setAck('system.led.mode', mode);
                await store.setAck('system.led.status', on);
                return true;
            }

            default:
                return false;
        }
    }

    private async setPower(on: boolean): Promise<void> {
        const { rest, ssip, capabilities, store } = this.ctx;

        // Powering on over HTTP only works from "Sleep"; from full suspend the HTTP server is
        // down and a magic packet is the only route.
        if (on) {
            try {
                if (capabilities.supports('system', 'setPowerStatus')) {
                    await rest.call('system', 'setPowerStatus', [{ status: true }]);
                    await store.setAck('power.state', true);
                    return;
                }
            } catch (e) {
                const error = e as BraviaError;
                if (error.kind !== 'transport' && error.kind !== 'displayOff') {
                    throw e;
                }
                this.ctx.store.log.info(
                    'Display did not answer setPowerStatus (likely suspended); falling back to Wake-on-LAN',
                );
            }
            await this.wakeDisplay();
            return;
        }

        if (capabilities.supports('system', 'setPowerStatus')) {
            await rest.call('system', 'setPowerStatus', [{ status: false }]);
        } else if (ssip) {
            await ssip.controlChecked(SSIP_COMMANDS.power, encodeNumericParam(0));
        } else {
            throw new BraviaError('No transport available to change power state', 'unsupported');
        }
        await store.setAck('power.state', false);
    }

    private async wakeDisplay(): Promise<void> {
        const mac = this.macAddress ?? this.ctx.config.macAddress;
        if (!mac) {
            throw new BraviaError(
                'Cannot send Wake-on-LAN: the display MAC address is unknown. ' +
                    'Set it in the instance configuration, or power the display on once so it can be read.',
                'badRequest',
            );
        }
        await wake(mac, { broadcastAddress: this.broadcastAddress ?? this.ctx.config.broadcastAddress });
    }

    public async onNotify(message: SsipMessage): Promise<boolean> {
        if (message.command !== SSIP_COMMANDS.power) {
            return false;
        }
        const value = parseNumericAnswer(message.parameter);
        if (value === null) {
            return true;
        }
        await this.ctx.store.setAck('power.state', value === 1);
        await this.ctx.store.setAck('power.status', value === 1 ? 'active' : 'standby');
        return true;
    }
}
