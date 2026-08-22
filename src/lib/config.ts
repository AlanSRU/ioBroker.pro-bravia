/**
 * Instance-configuration validation.
 *
 * jsonConfig `min`/`max` constrains the admin form only. A value can still reach the adapter
 * out of range — edited through the objects tab, restored from a backup, or written by a
 * script — so every configurable interval and timeout is clamped here as well.
 */

/** Poll interval bounds, in seconds. The upper bound keeps the timer well inside 2^31-1 ms. */
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 3600;
export const DEFAULT_POLL_SECONDS = 30;

/** Request timeout bounds, in seconds. */
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 5;

/**
 * Clamp a configured number into a usable range.
 *
 * Anything absent, non-numeric, negative or zero falls back to `fallback` rather than being
 * clamped up to `min`, so a blank field behaves as "unset" instead of silently becoming the
 * fastest allowed poll.
 */
export function clampSeconds(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

export const pollSecondsFrom = (value: unknown): number =>
    clampSeconds(value, MIN_POLL_SECONDS, MAX_POLL_SECONDS, DEFAULT_POLL_SECONDS);

export const timeoutSecondsFrom = (value: unknown): number =>
    clampSeconds(value, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS);

/** Startup retry bounds, in seconds. */
export const MIN_RETRY_SECONDS = 10;
export const MAX_RETRY_SECONDS = 300;

/**
 * Next startup-retry delay.
 *
 * Doubles from a floor of the poll interval (never faster than {@link MIN_RETRY_SECONDS}) up to
 * {@link MAX_RETRY_SECONDS}, so an unreachable display is not hammered every 30 s all night, but
 * one that comes back is still picked up within a few minutes.
 *
 * @param current the previous delay, or 0 when this is the first failure of a run
 */
export function nextRetrySeconds(current: number, pollSeconds: number): number {
    const floor = Math.max(MIN_RETRY_SECONDS, pollSeconds);
    if (current <= 0) {
        return floor;
    }
    return Math.min(current * 2, MAX_RETRY_SECONDS);
}
