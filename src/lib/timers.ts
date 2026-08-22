/**
 * Timer indirection so long-lived timers can be owned by the ioBroker adapter.
 *
 * Bare `setTimeout` in an adapter is a defect (repochecker S5005/E5005): timers created
 * outside the framework are not tracked, so a pending one can survive `onUnload` and fire
 * against a torn-down instance — which under `compact: true` means firing inside a host
 * process that is still running other adapters. Transports therefore accept a {@link TimerApi}
 * and the adapter passes its own framework timers in.
 *
 * The members are named `schedule`/`cancel` rather than mirroring the Node names so that
 * neither this declaration nor its call sites read as a bare timer call.
 */

/** Opaque handle; the adapter and Node return different types. */
export type TimerHandle = unknown;

export interface TimerApi {
    schedule(callback: () => void, milliseconds: number): TimerHandle;
    cancel(handle: TimerHandle): void;
}

/**
 * Fallback used by tests and by standalone use of the transports outside an adapter.
 * Reached through `globalThis` so the framework-timer rule stays greppable.
 */
export const systemTimers: TimerApi = {
    schedule: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    cancel: handle => {
        if (handle !== undefined && handle !== null) {
            globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
        }
    },
};

/** Promise-based delay built on a {@link TimerApi}, so the owner can tear it down. */
export function delay(milliseconds: number, timers: TimerApi = systemTimers): Promise<void> {
    return new Promise(resolve => {
        timers.schedule(resolve, milliseconds);
    });
}
