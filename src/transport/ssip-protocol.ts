/**
 * Pure codec for Sony's Simple IP Control (SSIP) protocol.
 *
 * Every message is exactly 24 bytes of ASCII:
 *
 * ```
 *   byte  0-1   header     "*S"
 *   byte  2     type       C=Control  E=Enquiry  A=Answer  N=Notify
 *   byte  3-6   command    FourCC
 *   byte  7-22  parameter  16 chars
 *   byte  23    footer     0x0A (LF)
 * ```
 *
 * No I/O happens here — see `ssip-client.ts` for the socket.
 */

export const SSIP_PORT = 20060;
export const SSIP_MESSAGE_LENGTH = 24;

const HEADER = '*S';
const FOOTER = '\n';
const PARAM_LENGTH = 16;

/** Parameter meaning "no value supplied" (16 `#`). */
export const PARAM_NONE = '#'.repeat(PARAM_LENGTH);
/** Answer parameter signalling success, and also the numeric value 0. */
export const PARAM_SUCCESS = '0'.repeat(PARAM_LENGTH);
/** Answer parameter signalling a general error. */
export const PARAM_ERROR = 'F'.repeat(PARAM_LENGTH);
/** Answer parameter signalling "not found" / "not available for current input". */
export const PARAM_NOT_FOUND = 'N'.repeat(PARAM_LENGTH);

export type SsipMessageType = 'C' | 'E' | 'A' | 'N';

/** The FourCC commands supported by BRAVIA Professional Displays. */
export const SSIP_COMMANDS = {
    ircc: 'IRCC',
    power: 'POWR',
    togglePower: 'TPOW',
    volume: 'VOLU',
    audioMute: 'AMUT',
    input: 'INPT',
    pictureMute: 'PMUT',
    togglePictureMute: 'TPMU',
    sceneSetting: 'SCEN',
    broadcastAddress: 'BADR',
    macAddress: 'MADR',
} as const;

export type SsipCommand = (typeof SSIP_COMMANDS)[keyof typeof SSIP_COMMANDS];

export interface SsipMessage {
    type: SsipMessageType;
    command: string;
    /** Raw 16-character parameter field, exactly as it appeared on the wire. */
    parameter: string;
}

export class SsipProtocolError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'SsipProtocolError';
    }
}

/**
 * Left-pad a number into the 16-char parameter field (Sony pads numerics with `0`).
 *
 */
export function encodeNumericParam(value: number): string {
    if (!Number.isInteger(value) || value < 0) {
        throw new SsipProtocolError(`Numeric parameter must be a non-negative integer, got ${value}`);
    }
    const text = String(value);
    if (text.length > PARAM_LENGTH) {
        throw new SsipProtocolError(`Numeric parameter ${value} exceeds ${PARAM_LENGTH} characters`);
    }
    return text.padStart(PARAM_LENGTH, '0');
}

/**
 * Right-pad a string into the 16-char parameter field (Sony pads strings with `#`).
 *
 */
export function encodeStringParam(value: string): string {
    if (value.length > PARAM_LENGTH) {
        throw new SsipProtocolError(`String parameter "${value}" exceeds ${PARAM_LENGTH} characters`);
    }
    return value.padEnd(PARAM_LENGTH, '#');
}

/**
 * Input parameter layout: 8 digits of input type followed by 8 digits of port.
 * e.g. HDMI 2 -> `0000000100000002`
 */
export const SSIP_INPUT_TYPES = {
    hdmi: 1,
    composite: 3,
    component: 4,
    screenMirroring: 5,
} as const;

export type SsipInputType = keyof typeof SSIP_INPUT_TYPES;

export function encodeInputParam(type: SsipInputType, port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 9999) {
        throw new SsipProtocolError(`Input port must be an integer 1-9999, got ${port}`);
    }
    return String(SSIP_INPUT_TYPES[type]).padStart(8, '0') + String(port).padStart(8, '0');
}

export function decodeInputParam(parameter: string): {
    type: SsipInputType;
    port: number;
} | null {
    if (!/^\d{16}$/.test(parameter)) {
        return null;
    }
    const typeCode = Number(parameter.slice(0, 8));
    const port = Number(parameter.slice(8));
    const type = (Object.keys(SSIP_INPUT_TYPES) as SsipInputType[]).find(key => SSIP_INPUT_TYPES[key] === typeCode);
    if (!type || port < 1) {
        return null;
    }
    return { type, port };
}

/**
 * Serialise a message to its 24-byte wire form.
 *
 */
export function encodeMessage(type: SsipMessageType, command: string, parameter: string = PARAM_NONE): Buffer {
    if (command.length !== 4) {
        throw new SsipProtocolError(`Command must be exactly 4 characters, got "${command}"`);
    }
    if (parameter.length !== PARAM_LENGTH) {
        throw new SsipProtocolError(`Parameter must be exactly ${PARAM_LENGTH} characters, got "${parameter}"`);
    }
    return Buffer.from(HEADER + type + command + parameter + FOOTER, 'ascii');
}

export const encodeControl = (command: string, parameter: string = PARAM_NONE): Buffer =>
    encodeMessage('C', command, parameter);

export const encodeEnquiry = (command: string): Buffer => encodeMessage('E', command, PARAM_NONE);

/**
 * Parse exactly one 24-byte message. Throws if the frame is malformed.
 *
 */
export function decodeMessage(frame: Buffer | string): SsipMessage {
    const text = typeof frame === 'string' ? frame : frame.toString('ascii');
    if (text.length !== SSIP_MESSAGE_LENGTH) {
        throw new SsipProtocolError(`Expected ${SSIP_MESSAGE_LENGTH} bytes, got ${text.length}`);
    }
    if (!text.startsWith(HEADER)) {
        throw new SsipProtocolError(`Bad header: "${text.slice(0, 2)}"`);
    }
    if (!text.endsWith(FOOTER)) {
        throw new SsipProtocolError('Missing LF footer');
    }
    const typeChar = text[2];
    if (typeChar !== 'C' && typeChar !== 'E' && typeChar !== 'A' && typeChar !== 'N') {
        throw new SsipProtocolError(`Unknown message type "${typeChar}"`);
    }
    const type: SsipMessageType = typeChar;
    return { type, command: text.slice(3, 7), parameter: text.slice(7, 23) };
}

/**
 * Split a receive buffer into complete messages, returning the parsed messages plus
 * whatever trailing bytes belong to an incomplete frame.
 *
 * Resynchronises on the `*S` header so a truncated or corrupt frame cannot desync the stream.
 *
 */
export function decodeStream(buffer: Buffer): { messages: SsipMessage[]; rest: Buffer } {
    const messages: SsipMessage[] = [];
    let offset = 0;

    while (offset + SSIP_MESSAGE_LENGTH <= buffer.length) {
        if (buffer[offset] !== 0x2a || buffer[offset + 1] !== 0x53) {
            const next = buffer.indexOf('*S', offset + 1, 'ascii');
            if (next === -1) {
                return { messages, rest: Buffer.alloc(0) };
            }
            offset = next;
            continue;
        }
        const frame = buffer.subarray(offset, offset + SSIP_MESSAGE_LENGTH);
        try {
            messages.push(decodeMessage(frame));
            offset += SSIP_MESSAGE_LENGTH;
        } catch {
            // Header matched but the frame is bad — skip past it and resync.
            offset += 2;
        }
    }

    // Preserve a partial frame, but only if it could still become one.
    let rest = buffer.subarray(offset);
    if (rest.length > 0 && rest[0] !== 0x2a) {
        const next = rest.indexOf('*S', 0, 'ascii');
        rest = next === -1 ? Buffer.alloc(0) : rest.subarray(next);
    }
    return { messages, rest };
}

export const isErrorAnswer = (message: SsipMessage): boolean => message.parameter === PARAM_ERROR;
export const isNotFoundAnswer = (message: SsipMessage): boolean => message.parameter === PARAM_NOT_FOUND;

/**
 * Read a zero-padded numeric answer parameter. Returns null for `F...`/`N...`/non-numeric.
 *
 */
export function parseNumericAnswer(parameter: string): number | null {
    return /^\d{16}$/.test(parameter) ? Number(parameter) : null;
}

/**
 * Read a `#`-padded string answer parameter. Returns null for error answers.
 *
 */
export function parseStringAnswer(parameter: string): string | null {
    if (parameter === PARAM_ERROR || parameter === PARAM_NOT_FOUND) {
        return null;
    }
    return parameter.replace(/#+$/, '');
}

/**
 * Numeric IR codes accepted by the SSIP `IRCC` command. Distinct from the base64
 * codes used by IRCC-IP over SOAP.
 */
export const SSIP_IR_CODES = {
    Display: 5,
    Home: 6,
    Options: 7,
    Return: 8,
    Up: 9,
    Down: 10,
    Right: 11,
    Left: 12,
    Confirm: 13,
    Red: 14,
    Green: 15,
    Yellow: 16,
    Blue: 17,
    Num1: 18,
    Num2: 19,
    Num3: 20,
    Num4: 21,
    Num5: 22,
    Num6: 23,
    Num7: 24,
    Num8: 25,
    Num9: 26,
    Num0: 27,
    VolumeUp: 30,
    VolumeDown: 31,
    Mute: 32,
    ChannelUp: 33,
    ChannelDown: 34,
    Subtitle: 35,
    Dot: 38,
    PictureOff: 50,
    Wide: 61,
    Jump: 62,
    SyncMenu: 76,
    Forward: 77,
    Play: 78,
    Rewind: 79,
    Prev: 80,
    Stop: 81,
    Next: 82,
    Pause: 84,
    FlashPlus: 86,
    FlashMinus: 87,
    TvPower: 98,
    Audio: 99,
    Input: 101,
    Sleep: 104,
    SleepTimer: 105,
    Video2: 108,
    PictureMode: 110,
    DemoSurround: 121,
    Hdmi1: 124,
    Hdmi2: 125,
    Hdmi3: 126,
    Hdmi4: 127,
    ActionMenu: 129,
    Help: 130,
} as const;

export type SsipIrKey = keyof typeof SSIP_IR_CODES;
