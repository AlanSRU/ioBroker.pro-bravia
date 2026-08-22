import {
    DEFAULT_POLL_SECONDS,
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
