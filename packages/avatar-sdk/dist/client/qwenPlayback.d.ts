export declare const QWEN_PLAYBACK_RATE = 24000;
export declare const QWEN_MAX_CHUNK_SAMPLES: number;
export declare const QWEN_MAX_QUEUED_SAMPLES: number;
export declare const QWEN_MAX_RESPONSE_SAMPLES: number;
export declare const QWEN_MAX_RESPONSE_IDS = 128;
export declare const QWEN_MAX_PENDING_SEGMENTS = 512;
export declare const QWEN_OUTPUT_STALL_MS = 5000;
/** Pinned vLLM-Omni 423 playback ACK. Milliseconds are quantized from played samples. */
export interface QwenPlaybackAck {
    type: 'playback.ack';
    response_id: string;
    item_id: string;
    played_ms: number;
    committed_ms: number;
}
export type QwenPlaybackError = 'invalid_response' | 'invalid_pcm' | 'response_not_started' | 'audio_after_done' | 'playback_capacity' | 'output_clock' | 'output_stalled' | 'audio_device';
export interface QwenPlaybackTimer {
    now(): number;
    schedule(callback: () => void, milliseconds: number): unknown;
    cancel(handle: unknown): void;
}
interface Options {
    onAck: (ack: QwenPlaybackAck) => void;
    onError?: (code: QwenPlaybackError) => void;
    createContext?: () => AudioContext;
    timer?: QwenPlaybackTimer;
}
/**
 * Output-only, single-session PCM player. It never reads, clears or pauses input.
 * ACKs follow the WebAudio output timestamp, not received bytes or onended.
 * This is an output-clock estimate; actual acoustic cancellation needs browser QA.
 */
export declare class QwenPlayback {
    private readonly options;
    readonly context: AudioContext;
    readonly analyser: AnalyserNode;
    private readonly timer;
    private readonly responses;
    private poll?;
    private pollEpoch;
    private closed;
    private closePromise?;
    private outputTime;
    private renderTime;
    private scheduled;
    private progressAt;
    private progressSamples;
    constructor(options: Options);
    get isClosed(): boolean;
    get queuedSamples(): number;
    get pendingSegments(): number;
    isSuppressed(id: string): boolean;
    resume(): Promise<boolean>;
    /** Called for response.created; IDs can never be reused, even after drain. */
    begin(id: string): boolean;
    /** A wire delta contains complete little-endian PCM16 samples at24k, without a WAV header. */
    enqueue(id: string, bytes: Uint8Array): boolean;
    /** response.output_audio.done seals audio; ACK waits for the final output interval. */
    done(id: string): boolean;
    cursor(id: string): Readonly<{
        receivedSamples: number;
        playedSamples: number;
        done: boolean;
        cancelled: boolean;
    }> | undefined;
    /** Immediate local stop + permanent tombstone; return/send only its own conservative cursor. */
    clear(id: string): QwenPlaybackAck | undefined;
    clearAll(): QwenPlaybackAck[];
    /** Teardown emits no captions/ACKs into a potentially different account/session. */
    close(): Promise<void>;
    private fail;
    private ack;
    private readOutputTime;
    private measure;
    private refresh;
    private armPoll;
    private recomputeScheduled;
    private releaseSource;
}
export {};
