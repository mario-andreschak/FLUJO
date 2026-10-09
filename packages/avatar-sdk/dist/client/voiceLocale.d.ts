import type { Locale } from './locale';
declare const es: {
    browserRequired: string;
    playbackBlocked: string;
    microphoneDenied: string;
    streamFailed: string;
    unsupportedAudio: string;
    speechUnrecognized: string;
    recordingTooLong: string;
    messageTooLong: string;
    providerUnavailable: string;
};
export declare function voiceCopy(locale: Locale): {
    browserRequired: string;
    playbackBlocked: string;
    microphoneDenied: string;
    streamFailed: string;
    unsupportedAudio: string;
    speechUnrecognized: string;
    recordingTooLong: string;
    messageTooLong: string;
    providerUnavailable: string;
};
export declare class VoiceLocaleError extends Error {
    readonly key: keyof typeof es;
    constructor(key: keyof typeof es);
}
export declare function voiceError(locale: Locale, error: unknown, fallback?: keyof typeof es): string;
export declare function voiceRequestError(_status: number, _code: unknown): VoiceLocaleError;
export declare function voiceResponseError(response: Response): Promise<VoiceLocaleError>;
export {};
