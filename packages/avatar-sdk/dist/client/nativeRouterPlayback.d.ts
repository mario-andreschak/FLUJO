import { QwenPlayback } from './qwenPlayback';
import type { QwenPlaybackTimer } from './qwenPlayback';
/** This rate is the reviewed Chat PCM packaging assumption, not a provider guarantee. */
export declare const NATIVE_ROUTER_RATE = 24000;
export declare const NATIVE_ROUTER_RATE_QUALIFICATION: 'assumed';
export declare const nativeIdentifier: (value: unknown) => value is string;
export type NativeTurnEvent = {
    type: 'start';
    turnId: string;
    sampleRate: 24000;
    sampleRateQualification: 'assumed';
} | {
    type: 'audio';
    turnId: string;
    data: string;
} | {
    type: 'caption';
    turnId: string;
    text: string;
} | {
    type: 'complete';
    turnId: string;
    text: string;
    samples: number;
    usage: Record<string, unknown>;
} | {
    type: 'error';
    turnId: string;
    code: string;
    error?: string;
};
export interface NativePlayed {
    turnId: string;
    playedSamples: number;
    complete: boolean;
}
export declare function nativeAudioBytes(data: string): Uint8Array;
/** A complete event is required; network EOF never implies a successful response. */
export declare class NativeTurnProtocol {
    turnId?: string;
    private terminal;
    private bytes;
    private caption;
    accept(value: unknown): NativeTurnEvent;
    finish(): void;
}
export declare function nativeAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
/** Async handlers are awaited: fast native generation cannot bypass playback backpressure. */
export declare function readNativeTurn(response: Response, signal: AbortSignal, event: (event: NativeTurnEvent) => Promise<void> | void): Promise<void>;
interface PlaybackOptions {
    onPlayed: (receipt: NativePlayed) => void;
    onError?: () => void;
    createContext?: () => AudioContext;
    timer?: QwenPlaybackTimer;
}
/** Uses only Qwen's tested output ledger; its vendor-specific ACK never leaves this adapter. */
export declare class NativeRouterPlayback {
    private readonly options;
    readonly player: QwenPlayback;
    private readonly timer;
    private readonly turns;
    private closed;
    constructor(options: PlaybackOptions);
    get context(): AudioContext;
    get analyser(): AnalyserNode;
    get queuedSamples(): number;
    get isClosed(): boolean;
    resume(): Promise<boolean>;
    begin(turnId: string): boolean;
    private wait;
    enqueue(turnId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
    drain(turnId: string, expectedSamples: number, signal: AbortSignal): Promise<void>;
    cancel(turnId: string): void;
    private invalidate;
    close(): Promise<void>;
}
export {};
