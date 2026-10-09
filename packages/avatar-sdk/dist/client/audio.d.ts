export declare function wavFromPcm(chunks: Float32Array[], sourceRate: number, targetRate?: number): Uint8Array;
/** HTTP chunks may split in the middle of a signed little-endian sample. */
export declare class Pcm16Stream {
    private carry;
    decode(bytes: Uint8Array): Float32Array;
    finish(): void;
}
/** Round-trip decoded PCM16 exactly; used only for already quantized initial audio. */
export declare function pcm16FromFloat32(samples: Float32Array): Uint8Array;
/** Continuous raw PCM: carry fractional sample intervals across worklet blocks. */
export declare class Pcm16Resampler {
    private readonly ratio;
    private remaining;
    private weighted;
    constructor(sourceRate: number, targetRate?: number);
    encode(samples: Float32Array): Uint8Array;
    reset(): void;
}
/** Coalesce short acknowledgements, and drain every completed sentence in a delta. */
export declare function speechSentences(text: string, minimum?: number): {
    ready: string[];
    pending: string;
};
export declare function splitSpeechText(text: string, maximum?: number): string[];
export declare function boundedVoiceHistory<T extends {
    role: 'user' | 'assistant';
    content: string;
}>(history: T[]): T[];
export declare function base64Bytes(bytes: Uint8Array): string;
export declare function readNdjson(response: Response, onEvent: (event: Record<string, unknown>) => void): Promise<void>;
