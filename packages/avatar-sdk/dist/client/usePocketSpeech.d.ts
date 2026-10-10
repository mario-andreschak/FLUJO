export interface PocketResult {
    conversationId: string;
    messageId: string;
    locale: string;
}
/** Output only. The host supplies authenticated canonical-result transport. */
export declare function usePocketSpeech(request: (result: PocketResult, signal: AbortSignal) => Promise<Response>): {
    enabled: boolean;
    speaking: boolean;
    error: string;
    enable: () => void;
    disable: () => void;
    stop: () => void;
    speak: (result: PocketResult) => void;
};
