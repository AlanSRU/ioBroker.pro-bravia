/**
 * Translates the display's self-described settings into ioBroker state objects.
 *
 * `getPictureQualitySettings` / `getSpeakerSettings` / `getSoundSettings` all return the same
 * shape: a target name, its current value as a string, and a candidate list describing what
 * may be written to it. That candidate list is exactly the information ioBroker needs for
 * `common.min`/`max`/`step`/`states`, so the state tree is derived rather than hardcoded —
 * which is what keeps the adapter correct across models, firmware and the EU RED-DA variants.
 */

export interface SettingCandidate {
    value?: string;
    max?: number;
    min?: number;
    step?: number;
}

/** One entry as returned by any `getXxxSettings` method. */
export interface SettingEntry {
    target: string;
    currentValue: string;
    isAvailable?: boolean;
    candidate?: SettingCandidate[] | null;
}

export type SettingKind = 'number' | 'enum' | 'boolean' | 'text';

export interface SettingDescriptor {
    target: string;
    /** ioBroker state id segment, derived from the target name. */
    id: string;
    kind: SettingKind;
    common: ioBroker.StateCommon;
    /** Convert a wire value (always a string) into the ioBroker state value. */
    fromDevice(raw: string): ioBroker.StateValue;
    /** Convert an ioBroker state value into the string the display expects. */
    toDevice(value: ioBroker.StateValue): string;
}

/**
 * Characters ioBroker does not permit in object ids.
 *
 */
export function sanitiseId(target: string): string {
    const cleaned = target.replace(/[[\]*,;'"`<>\\?\s.]/g, '_');
    return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Split a camelCase target into a readable name: `colorTemperature` -> `Color temperature`.
 *
 */
export function humaniseTarget(target: string): string {
    const spaced = target
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim();
    // Sentence case: only the first word is capitalised, matching ioBroker naming convention.
    const lowered = spaced
        .split(' ')
        .map((word, index) => (index === 0 ? word : word.toLowerCase()))
        .join(' ');
    return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

const isNumericCandidate = (candidate: SettingCandidate): boolean =>
    typeof candidate.min === 'number' &&
    typeof candidate.max === 'number' &&
    candidate.min !== -1 &&
    candidate.max !== -1;

/** `on`/`off` pairs are far more usable in ioBroker as a boolean switch. */
const BOOLEAN_PAIRS: [string, string][] = [
    ['on', 'off'],
    ['true', 'false'],
    ['enabled', 'disabled'],
];

function detectBooleanPair(values: string[]): { on: string; off: string } | null {
    if (values.length !== 2) {
        return null;
    }
    const lower = values.map(value => value.toLowerCase());
    for (const [on, off] of BOOLEAN_PAIRS) {
        const onIndex = lower.indexOf(on);
        const offIndex = lower.indexOf(off);
        if (onIndex !== -1 && offIndex !== -1) {
            return { on: values[onIndex], off: values[offIndex] };
        }
    }
    return null;
}

/**
 * Build a descriptor for one settings target.
 *
 * @param entry     the entry as returned by the display
 * @param writable  false for targets the display exposes read-only
 */
export function describeSetting(entry: SettingEntry, writable = true): SettingDescriptor {
    const id = sanitiseId(entry.target);
    const name = humaniseTarget(entry.target);
    const candidates = entry.candidate ?? [];

    const numeric = candidates.find(isNumericCandidate);
    if (numeric) {
        const step = typeof numeric.step === 'number' && numeric.step > 0 ? numeric.step : undefined;
        return {
            target: entry.target,
            id,
            kind: 'number',
            common: {
                name,
                type: 'number',
                // `level` is the writable-number role; `value` is read-only by definition.
                role: writable ? 'level' : 'value',
                read: true,
                write: writable,
                min: numeric.min,
                max: numeric.max,
                ...(step !== undefined ? { step } : {}),
            },
            fromDevice: raw => {
                const parsed = Number(raw);
                return Number.isFinite(parsed) ? parsed : 0;
            },
            toDevice: value => String(Math.round(Number(value))),
        };
    }

    const values = candidates
        .map(candidate => candidate.value)
        .filter((v): v is string => typeof v === 'string' && v !== '');

    if (values.length > 0) {
        const pair = detectBooleanPair(values);
        if (pair) {
            return {
                target: entry.target,
                id,
                kind: 'boolean',
                common: {
                    name,
                    type: 'boolean',
                    role: writable ? 'switch' : 'indicator',
                    read: true,
                    write: writable,
                },
                fromDevice: raw => raw.toLowerCase() === pair.on.toLowerCase(),
                toDevice: value => (value ? pair.on : pair.off),
            };
        }

        return {
            target: entry.target,
            id,
            kind: 'enum',
            common: {
                name,
                type: 'string',
                role: 'text',
                read: true,
                write: writable,
                states: Object.fromEntries(values.map(value => [value, humaniseTarget(value)])),
            },
            fromDevice: raw => raw,
            toDevice: value => String(value),
        };
    }

    // No candidates: the display gives a value but does not describe what may be written.
    return {
        target: entry.target,
        id,
        kind: 'text',
        common: {
            name,
            type: 'string',
            role: 'text',
            read: true,
            write: writable,
        },
        fromDevice: raw => raw,
        toDevice: value => String(value),
    };
}

/**
 * Build descriptors for a whole settings response, skipping malformed entries.
 *
 */
export function describeSettings(entries: SettingEntry[], writable = true): SettingDescriptor[] {
    const seen = new Set<string>();
    const descriptors: SettingDescriptor[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry.target !== 'string' || entry.target === '') {
            continue;
        }
        const descriptor = describeSetting(entry, writable);
        // A duplicate id would silently overwrite an earlier state object.
        if (seen.has(descriptor.id)) {
            continue;
        }
        seen.add(descriptor.id);
        descriptors.push(descriptor);
    }
    return descriptors;
}
