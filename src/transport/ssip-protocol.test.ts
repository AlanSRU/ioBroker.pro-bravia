import {
    PARAM_ERROR,
    PARAM_NONE,
    PARAM_NOT_FOUND,
    PARAM_SUCCESS,
    SSIP_MESSAGE_LENGTH,
    SsipProtocolError,
    decodeInputParam,
    decodeMessage,
    decodeStream,
    encodeControl,
    encodeEnquiry,
    encodeInputParam,
    encodeMessage,
    encodeNumericParam,
    encodeStringParam,
    isErrorAnswer,
    isNotFoundAnswer,
    parseNumericAnswer,
    parseStringAnswer,
} from './ssip-protocol';

describe('parameter encoding', () => {
    it('left-pads numeric parameters with zeros', () => {
        expect(encodeNumericParam(29)).toBe('0000000000000029');
        expect(encodeNumericParam(0)).toBe(PARAM_SUCCESS);
    });

    it('rejects negative, fractional and oversized numerics', () => {
        expect(() => encodeNumericParam(-1)).toThrow(SsipProtocolError);
        expect(() => encodeNumericParam(1.5)).toThrow(SsipProtocolError);
        expect(() => encodeNumericParam(1e16)).toThrow(SsipProtocolError);
    });

    it('right-pads string parameters with #', () => {
        // The scene-setting example straight out of Sony's specification.
        expect(encodeStringParam('auto24pSync')).toBe('auto24pSync#####');
        expect(encodeStringParam('')).toBe(PARAM_NONE);
    });

    it('rejects oversized strings', () => {
        expect(() => encodeStringParam('x'.repeat(17))).toThrow(SsipProtocolError);
    });
});

describe('input parameter encoding', () => {
    it('encodes 8 digits of type followed by 8 digits of port', () => {
        expect(encodeInputParam('hdmi', 1)).toBe('0000000100000001');
        expect(encodeInputParam('hdmi', 2)).toBe('0000000100000002');
        expect(encodeInputParam('component', 3)).toBe('0000000400000003');
        expect(encodeInputParam('screenMirroring', 1)).toBe('0000000500000001');
    });

    it('rejects out-of-range ports', () => {
        expect(() => encodeInputParam('hdmi', 0)).toThrow(SsipProtocolError);
        expect(() => encodeInputParam('hdmi', 10000)).toThrow(SsipProtocolError);
    });

    it('round-trips through the decoder', () => {
        expect(decodeInputParam(encodeInputParam('composite', 12))).toEqual({ type: 'composite', port: 12 });
    });

    it('returns null for parameters that are not input descriptors', () => {
        expect(decodeInputParam(PARAM_ERROR)).toBeNull();
        // Input type 2 is not defined by the specification.
        expect(decodeInputParam('0000000200000001')).toBeNull();
        // Port 0 is not a valid input.
        expect(decodeInputParam('0000000100000000')).toBeNull();
    });
});

describe('message framing', () => {
    it('builds the 24-byte power-off frame from the specification', () => {
        const frame = encodeControl('POWR', PARAM_SUCCESS);
        expect(frame).toHaveLength(SSIP_MESSAGE_LENGTH);
        expect(frame.toString('ascii')).toBe('*SCPOWR0000000000000000\n');
    });

    it('builds enquiry frames with a # parameter', () => {
        expect(encodeEnquiry('POWR').toString('ascii')).toBe('*SEPOWR################\n');
    });

    it('rejects malformed commands and parameters', () => {
        expect(() => encodeMessage('C', 'POW', PARAM_NONE)).toThrow(SsipProtocolError);
        expect(() => encodeMessage('C', 'POWR', '000')).toThrow(SsipProtocolError);
    });

    it('parses an answer frame', () => {
        expect(decodeMessage('*SAPOWR0000000000000001\n')).toEqual({
            type: 'A',
            command: 'POWR',
            parameter: '0000000000000001',
        });
    });

    it('parses a notify frame', () => {
        const message = decodeMessage('*SNVOLU0000000000000025\n');
        expect(message.type).toBe('N');
        expect(parseNumericAnswer(message.parameter)).toBe(25);
    });

    it('rejects frames with a bad header, footer, type or length', () => {
        expect(() => decodeMessage('XXAPOWR0000000000000001\n')).toThrow(/header/i);
        expect(() => decodeMessage('*SAPOWR0000000000000001X')).toThrow(/footer/i);
        expect(() => decodeMessage('*SZPOWR0000000000000001\n')).toThrow(/message type/i);
        expect(() => decodeMessage('*SAPOWR\n')).toThrow(/24 bytes/i);
    });
});

describe('stream decoding', () => {
    it('splits several concatenated frames', () => {
        const buffer = Buffer.concat([
            encodeMessage('N', 'POWR', '0000000000000001'),
            encodeMessage('N', 'VOLU', '0000000000000012'),
        ]);
        const { messages, rest } = decodeStream(buffer);
        expect(messages.map(m => m.command)).toEqual(['POWR', 'VOLU']);
        expect(rest).toHaveLength(0);
    });

    it('holds back a partial trailing frame until the remainder arrives', () => {
        const full = encodeMessage('N', 'AMUT', '0000000000000001');
        const first = decodeStream(Buffer.concat([full, full.subarray(0, 10)]));
        expect(first.messages).toHaveLength(1);
        expect(first.rest).toHaveLength(10);

        const second = decodeStream(Buffer.concat([first.rest, full.subarray(10)]));
        expect(second.messages).toHaveLength(1);
        expect(second.rest).toHaveLength(0);
    });

    it('resynchronises after leading garbage', () => {
        const buffer = Buffer.concat([
            Buffer.from('noise-noise', 'ascii'),
            encodeMessage('N', 'PMUT', '0000000000000001'),
        ]);
        const { messages } = decodeStream(buffer);
        expect(messages).toHaveLength(1);
        expect(messages[0].command).toBe('PMUT');
    });

    it('discards a trailing fragment that can never become a frame', () => {
        const { messages, rest } = decodeStream(Buffer.from('garbage', 'ascii'));
        expect(messages).toHaveLength(0);
        expect(rest).toHaveLength(0);
    });
});

describe('answer interpretation', () => {
    it('recognises error and not-found answers', () => {
        expect(isErrorAnswer({ type: 'A', command: 'POWR', parameter: PARAM_ERROR })).toBe(true);
        expect(isNotFoundAnswer({ type: 'A', command: 'SCEN', parameter: PARAM_NOT_FOUND })).toBe(true);
        expect(isErrorAnswer({ type: 'A', command: 'POWR', parameter: PARAM_SUCCESS })).toBe(false);
    });

    it('parses numeric answers and rejects non-numeric ones', () => {
        expect(parseNumericAnswer('0000000000000029')).toBe(29);
        expect(parseNumericAnswer(PARAM_ERROR)).toBeNull();
        expect(parseNumericAnswer(PARAM_NONE)).toBeNull();
    });

    it('strips # padding from string answers', () => {
        expect(parseStringAnswer('192.168.0.14####')).toBe('192.168.0.14');
        expect(parseStringAnswer('auto24pSync#####')).toBe('auto24pSync');
        expect(parseStringAnswer(PARAM_ERROR)).toBeNull();
        expect(parseStringAnswer(PARAM_NOT_FOUND)).toBeNull();
    });
});
