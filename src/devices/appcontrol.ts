import { sanitiseId } from '../discovery/state-mapper';
import type { DeviceContext, FeatureModule } from './types';

/**
 * Application control — launching and terminating apps such as BRAVIA Signage.
 *
 * The installed application list is read from the display, so the per-app launch buttons match
 * whatever is actually on the unit.
 */

interface Application {
    title?: string;
    uri?: string;
    icon?: string;
}

export class AppControlModule implements FeatureModule {
    public readonly root = 'apps';
    public readonly name = 'appControl';

    private applications: Application[] = [];
    private readonly idToUri = new Map<string, string>();

    public constructor(private readonly ctx: DeviceContext) {}

    public async init(): Promise<void> {
        const { store, capabilities } = this.ctx;

        if (!capabilities.hasService('appControl')) {
            return;
        }

        const canLaunch = capabilities.supports('appControl', 'setActiveApp');

        await store.ensureChannel('apps', 'Applications');
        await store.ensureState('apps.list', {
            name: 'Installed applications (JSON)',
            type: 'string',
            role: 'json',
            read: true,
            write: false,
        });

        if (canLaunch) {
            await store.ensureState('apps.launch', {
                name: 'Launch application by URI',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
            });
        }
        if (capabilities.supports('appControl', 'terminateApps')) {
            await store.ensureState('apps.terminate', {
                name: 'Terminate all applications',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            });
        }

        this.applications = await this.readApplications();
        await store.setAck('apps.list', JSON.stringify(this.applications));

        if (this.applications.length > 0 && canLaunch) {
            await store.ensureChannel('apps.items', 'Installed applications');
            for (const application of this.applications) {
                if (!application.uri) {
                    continue;
                }
                const id = sanitiseId(application.title || application.uri);
                if (this.idToUri.has(id)) {
                    continue;
                }
                this.idToUri.set(id, application.uri);
                await store.ensureChannel(`apps.items.${id}`, application.title ?? id);
                await store.ensureState(`apps.items.${id}.uri`, {
                    name: 'URI',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                });
                await store.ensureState(`apps.items.${id}.launch`, {
                    name: `Launch ${application.title ?? id}`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                });
                await store.setAck(`apps.items.${id}.uri`, application.uri);
            }
        }
    }

    private async readApplications(): Promise<Application[]> {
        if (!this.ctx.capabilities.supports('appControl', 'getApplicationList')) {
            return [];
        }
        try {
            const result = await this.ctx.rest.call<Application[][]>('appControl', 'getApplicationList');
            return Array.isArray(result[0]) ? result[0] : [];
        } catch (e) {
            this.ctx.reportError(e, 'appControl.getApplicationList');
            return [];
        }
    }

    public async refresh(): Promise<void> {
        // The installed application list only changes on install/uninstall, so it is read at
        // startup rather than on every poll.
    }

    public async write(path: string, value: ioBroker.StateValue): Promise<boolean> {
        const { rest, store } = this.ctx;

        if (path === 'launch') {
            await rest.call('appControl', 'setActiveApp', [{ uri: String(value) }]);
            await store.setAck('apps.launch', value);
            return true;
        }
        if (path === 'terminate') {
            await rest.call('appControl', 'terminateApps');
            return true;
        }

        const button = /^items\.([^.]+)\.launch$/.exec(path);
        if (button) {
            const uri = this.idToUri.get(button[1]);
            if (!uri) {
                return false;
            }
            await rest.call('appControl', 'setActiveApp', [{ uri }]);
            await store.setAck('apps.launch', uri);
            return true;
        }

        return false;
    }
}
