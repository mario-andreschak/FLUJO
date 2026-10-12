/** A bounded observer of the existing microphone. Native voice keeps its own clock. */
export interface Utterance {
    chunks: Float32Array[];
    sampleRate: number;
    capped: boolean;
}
export declare class UtteranceCollector {
    readonly sampleRate: number;
    readonly maximumSeconds: number;
    private pre;
    private preSamples;
    private chunks;
    private samples;
    private onset;
    private quiet;
    private active;
    private draining;
    constructor(sampleRate: number, maximumSeconds?: number);
    reset(): void;
    push(samples: Float32Array, voiced: boolean): Utterance | undefined;
}
/** One in-flight observation and one latest queued utterance; identity changes erase both. */
export declare class UtteranceObserver {
    private readonly request;
    private readonly result;
    private readonly failure;
    private epoch;
    private active?;
    private queued?;
    private disposed;
    constructor(request: (utterance: Utterance, signal: AbortSignal) => Promise<string>, result: (text: string) => void, failure?: () => void);
    offer(utterance: Utterance): void;
    invalidate(): void;
    dispose(): void;
    private start;
}
