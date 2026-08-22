/** Error taxonomy shared by the REST, IRCC and SSIP transports. */

/**
 * How the adapter should react to a failed call. Keeping this separate from the raw
 * numeric code means callers branch on intent rather than on a long list of magic numbers.
 */
export type BraviaErrorKind =
    /** Bad or missing pre-shared key. Retrying will not help until the user fixes config. */
    | 'auth'
    /** This display does not implement the method/version/target at all. Stop asking. */
    | 'unsupported'
    /** Display is in standby. Expected, and not worth logging loudly. */
    | 'displayOff'
    /** Transient — back off and try again. */
    | 'retryable'
    /** Our request was wrong (bad argument). A retry would fail identically. */
    | 'badRequest'
    /** Network-level failure: refused, timed out, unreachable. */
    | 'transport'
    /** Anything we have no specific handling for. */
    | 'unknown';

export class BraviaError extends Error {
    public readonly kind: BraviaErrorKind;
    public readonly code?: number;
    /** `service.method` that produced the error, for log context. */
    public readonly context?: string;

    public constructor(message: string, kind: BraviaErrorKind, code?: number, context?: string) {
        super(message);
        this.name = 'BraviaError';
        this.kind = kind;
        this.code = code;
        this.context = context;
    }

    /** True when trying the same call again later could plausibly succeed. */
    public get isRetryable(): boolean {
        return this.kind === 'retryable' || this.kind === 'transport';
    }
}

/**
 * Sony's documented error codes, mapped to the reaction they warrant.
 * Source: REST API reference, "Error Code" section.
 */
const ERROR_KINDS: Record<number, BraviaErrorKind> = {
    // HTTP-level
    401: 'auth', // Unauthorized
    403: 'auth', // Forbidden
    404: 'unsupported', // No API matching the requested version
    413: 'badRequest', // Request entity too large
    414: 'badRequest', // Request-URI too long
    501: 'unsupported', // Not implemented
    503: 'retryable', // Service unavailable (too many concurrent connections)

    // System
    1: 'unknown', // Any
    2: 'retryable', // Timeout
    3: 'badRequest', // Illegal argument
    5: 'badRequest', // Illegal request
    7: 'retryable', // Illegal state
    12: 'unsupported', // No such method
    14: 'unsupported', // Unsupported version
    15: 'unsupported', // Unsupported operation

    // Common
    40000: 'retryable', // Long-polling timeout
    40001: 'retryable', // Clients over maximum
    40002: 'unknown', // Encryption failed
    40003: 'retryable', // Request duplicated — previous response still outstanding
    40004: 'badRequest', // Multiple settings failed; re-read to find which
    40005: 'displayOff', // Display is turned off
    40006: 'unknown', // General error, see error_message

    // system service
    40200: 'auth', // Password expired
    40201: 'retryable', // AC power required

    // videoScreen service
    40600: 'retryable', // Screen change in progress

    // audio service
    40800: 'unsupported', // Target not supported
    40801: 'badRequest', // Volume out of range

    // avContent service
    41000: 'badRequest', // Content is protected
    41001: 'badRequest', // Content does not exist
    41002: 'badRequest', // Storage has no content
    41015: 'badRequest', // Empty channel list
    41020: 'badRequest', // Storage does not exist
    41021: 'badRequest', // Storage is full
    41024: 'unsupported', // Content is not supported
};

export function classifyErrorCode(code: number): BraviaErrorKind {
    return ERROR_KINDS[code] ?? 'unknown';
}

/** `40004 Multiple Settings Failed` — the caller must re-read to learn which target failed. */
export const ERROR_MULTIPLE_SETTINGS_FAILED = 40004;
/** `40005 Display is turned off` — several services return this whenever the panel is in standby. */
export const ERROR_DISPLAY_OFF = 40005;
