import { describeSetting, describeSettings, humaniseTarget, sanitiseId } from './state-mapper';

describe('id and name derivation', () => {
    it('replaces characters ioBroker forbids in object ids', () => {
        expect(sanitiseId('color')).toBe('color');
        expect(sanitiseId('picture.mode')).toBe('picture_mode');
        expect(sanitiseId('a[b]c*d')).toBe('a_b_c_d');
        expect(sanitiseId('')).toBe('unknown');
    });

    it('turns camelCase targets into readable names', () => {
        expect(humaniseTarget('colorTemperature')).toBe('Color temperature');
        expect(humaniseTarget('xtendedDynamicRange')).toBe('Xtended dynamic range');
        expect(humaniseTarget('color')).toBe('Color');
    });
});

describe('numeric targets', () => {
    const descriptor = describeSetting({
        target: 'brightness',
        currentValue: '45',
        isAvailable: true,
        candidate: [{ min: 0, max: 100, step: 1 }],
    });

    it('maps min/max/step onto ioBroker common', () => {
        expect(descriptor.kind).toBe('number');
        expect(descriptor.common).toMatchObject({
            type: 'number',
            role: 'level',
            read: true,
            write: true,
            min: 0,
            max: 100,
            step: 1,
        });
    });

    it('converts values in both directions', () => {
        expect(descriptor.fromDevice('45')).toBe(45);
        expect(descriptor.toDevice(72)).toBe('72');
        // The API only accepts integers, so a fractional write is rounded rather than rejected.
        expect(descriptor.toDevice(72.6)).toBe('73');
    });

    it('falls back to 0 for an unparseable device value', () => {
        expect(descriptor.fromDevice('n/a')).toBe(0);
    });

    it('uses the read-only value role when the target is not writable', () => {
        const readOnly = describeSetting(
            { target: 'brightness', currentValue: '1', candidate: [{ min: 0, max: 10, step: 1 }] },
            false,
        );
        expect(readOnly.common).toMatchObject({ role: 'value', write: false, read: true });
    });

    it('omits step when the display reports it as unavailable', () => {
        const descriptor = describeSetting({
            target: 'subwooferLevel',
            currentValue: '12',
            candidate: [{ min: 0, max: 24, step: -1 }],
        });
        expect(descriptor.common).not.toHaveProperty('step');
        expect(descriptor.common).toMatchObject({ min: 0, max: 24 });
    });

    it('ignores a candidate whose min/max are the -1 "not numeric" sentinel', () => {
        const descriptor = describeSetting({
            target: 'pictureMode',
            currentValue: 'standard',
            candidate: [{ value: 'standard', min: -1, max: -1, step: -1 }, { value: 'vivid' }],
        });
        expect(descriptor.kind).toBe('enum');
    });
});

describe('enumerated targets', () => {
    const descriptor = describeSetting({
        target: 'pictureMode',
        currentValue: 'standard',
        candidate: [{ value: 'vivid' }, { value: 'standard' }, { value: 'cinema' }],
    });

    it('maps the candidate list onto common.states', () => {
        expect(descriptor.kind).toBe('enum');
        expect(descriptor.common).toMatchObject({ type: 'string', role: 'text', read: true, write: true });
        expect(descriptor.common.states).toEqual({
            vivid: 'Vivid',
            standard: 'Standard',
            cinema: 'Cinema',
        });
    });

    it('passes values through unchanged', () => {
        expect(descriptor.fromDevice('cinema')).toBe('cinema');
        expect(descriptor.toDevice('vivid')).toBe('vivid');
    });
});

describe('two-value targets become booleans', () => {
    it('maps on/off to a switch', () => {
        const descriptor = describeSetting({
            target: 'lightSensor',
            currentValue: 'off',
            candidate: [{ value: 'on' }, { value: 'off' }],
        });
        expect(descriptor.kind).toBe('boolean');
        expect(descriptor.common).toMatchObject({ type: 'boolean', role: 'switch', read: true, write: true });
        expect(descriptor.fromDevice('on')).toBe(true);
        expect(descriptor.fromDevice('off')).toBe(false);
        expect(descriptor.toDevice(true)).toBe('on');
        expect(descriptor.toDevice(false)).toBe('off');
    });

    it("preserves the display's own casing when writing back", () => {
        const descriptor = describeSetting({
            target: 'demo',
            currentValue: 'OFF',
            candidate: [{ value: 'ON' }, { value: 'OFF' }],
        });
        expect(descriptor.toDevice(true)).toBe('ON');
        expect(descriptor.fromDevice('ON')).toBe(true);
    });

    it('uses the read-only indicator role when not writable', () => {
        const descriptor = describeSetting(
            { target: 'lightSensor', currentValue: 'off', candidate: [{ value: 'on' }, { value: 'off' }] },
            false,
        );
        expect(descriptor.common).toMatchObject({ role: 'indicator', write: false });
    });

    it('leaves a non-boolean two-value pair as an enum', () => {
        const descriptor = describeSetting({
            target: 'tvPosition',
            currentValue: 'tableTop',
            candidate: [{ value: 'tableTop' }, { value: 'wallMount' }],
        });
        expect(descriptor.kind).toBe('enum');
    });
});

describe('targets without candidates', () => {
    it('becomes a free-text state', () => {
        const descriptor = describeSetting({ target: 'contentType', currentValue: 'video', candidate: null });
        expect(descriptor.kind).toBe('text');
        expect(descriptor.common).toMatchObject({ type: 'string', role: 'text', read: true, write: true });
    });

    it('treats an empty candidate array the same way', () => {
        expect(describeSetting({ target: 'x', currentValue: '', candidate: [] }).kind).toBe('text');
    });
});

describe('describeSettings', () => {
    it('skips malformed entries and de-duplicates colliding ids', () => {
        const descriptors = describeSettings([
            { target: 'color', currentValue: '1', candidate: [{ min: 0, max: 100, step: 1 }] },
            // Malformed: no target.
            { currentValue: '2' } as never,
            { target: 'color mode', currentValue: '3', candidate: null },
            // Sanitises to the same id as 'color mode', so it must not overwrite it.
            { target: 'color.mode', currentValue: '4', candidate: null },
        ]);
        expect(descriptors.map(d => d.id)).toEqual(['color', 'color_mode']);
        expect(descriptors[0].kind).toBe('number');
    });

    it('keeps targets the display reports as currently unavailable', () => {
        // isAvailable:false means "not applicable to the current input", not "does not exist" —
        // the state must still exist or it would vanish whenever the input changes.
        const descriptors = describeSettings([
            {
                target: 'hdrMode',
                currentValue: 'off',
                isAvailable: false,
                candidate: [{ value: 'on' }, { value: 'off' }],
            },
        ]);
        expect(descriptors).toHaveLength(1);
        expect(descriptors[0].id).toBe('hdrMode');
    });
});
