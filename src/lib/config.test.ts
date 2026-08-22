import {
    DEFAULT_POLL_SECONDS,
    MAX_RETRY_SECONDS,
    MIN_RETRY_SECONDS,
    nextRetrySeconds,
    DEFAULT_TIMEOUT_SECONDS,
    MAX_POLL_SECONDS,
    MIN_POLL_SECONDS,
    pollSecondsFrom,
    timeoutSecondsFrom,
} from './config';

describe('poll interval clamping', () => {
    it('keeps a sensible configured value', () => {
        expect(pollSecondsFrom(30)).toBe(30);
        expect(pollSecondsFrom(120)).toBe(120);
    });

    it('falls back when the value is missing or unusable', () => {
        // A blank field must mean "unset", not "poll as fast as allowed".
        for (const value of [undefined, null, '', 0, -1, NaN, 'abc', {}]) {
            expect(pollSecondsFrom(value)).toBe(DEFAULT_POLL_SECONDS);
        }
    });

    it('clamps values outside the supported range', () => {
        expect(pollSecondsFrom(1)).toBe(MIN_POLL_SECONDS);
        expect(pollSecondsFrom(99999)).toBe(MAX_POLL_SECONDS);
        // Well inside the 2^31-1 ms setInterval ceiling.
        expect(pollSecondsFrom(Number.MAX_SAFE_INTEGER) * 1000).toBeLessThan(2147483647);
    });

    it('accepts numeric strings, as the admin form may submit them', () => {
        expect(pollSecondsFrom('45')).toBe(45);
    });

    it('rounds fractional values to whole seconds', () => {
        expect(pollSecondsFrom(30.6)).toBe(31);
    });
});

describe('request timeout clamping', () => {
    it('keeps a sensible value and falls back otherwise', () => {
        expect(timeoutSecondsFrom(5)).toBe(5);
        expect(timeoutSecondsFrom(0)).toBe(DEFAULT_TIMEOUT_SECONDS);
        expect(timeoutSecondsFrom(undefined)).toBe(DEFAULT_TIMEOUT_SECONDS);
    });

    it('clamps to the supported range', () => {
        expect(timeoutSecondsFrom(1000)).toBe(60);
        expect(timeoutSecondsFrom(0.2)).toBe(1);
    });
});

describe('startup retry backoff', () => {
    it('starts at the poll interval but never faster than the floor', () => {
        expect(nextRetrySeconds(0, 30)).toBe(30);
        // A 5s poll must not mean a 5s reconnect storm against a display that is switched off.
        expect(nextRetrySeconds(0, 5)).toBe(MIN_RETRY_SECONDS);
    });

    it('doubles up to the ceiling and stays there', () => {
        expect(nextRetrySeconds(30, 30)).toBe(60);
        expect(nextRetrySeconds(60, 30)).toBe(120);
        expect(nextRetrySeconds(240, 30)).toBe(MAX_RETRY_SECONDS);
        expect(nextRetrySeconds(MAX_RETRY_SECONDS, 30)).toBe(MAX_RETRY_SECONDS);
    });

    it('reaches the ceiling in few enough attempts to keep the log quiet overnight', () => {
        let delay = 0;
        let attempts = 0;
        let elapsed = 0;
        // Twelve hours unreachable, at the default poll interval.
        while (elapsed < 12 * 3600) {
            delay = nextRetrySeconds(delay, DEFAULT_POLL_SECONDS);
            elapsed += delay;
            attempts++;
        }
        // A fixed 30s retry would be ~1,440 attempts; backoff must be far below that.
        expect(attempts).toBeLessThan(160);
    });

    it('keeps the delay well inside the setTimeout limit', () => {
        expect(MAX_RETRY_SECONDS * 1000).toBeLessThan(2147483647);
    });
});
