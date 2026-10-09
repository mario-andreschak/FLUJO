import type { AvatarId, Phase } from './domain';
import { type Locale } from './locale';
import type { NativeVoiceTransport } from './nativeVoiceTransport';
export { voiceHeaders } from './nativeVoiceTransport';
export type { NativeVoiceTransport } from './nativeVoiceTransport';
interface Options {
    avatar: AvatarId;
    locale?: Locale;
    onTranscript: (id: string, role: 'user' | 'assistant', text: string, done: boolean) => void;
    onUserUtterance?: () => void;
    backgroundAsr?: boolean;
    /** Work recordings go straight to recognition and the host work lane, without a second spoken acknowledgement. */
    workInput?: boolean;
    observerPaused?: boolean;
    onObservedTranscript?: (id: string, text: string) => void;
    onObserverError?: () => void;
    onInterrupted?: () => void;
    /** An authenticated host may replace URLs/headers without changing audio or work ownership. */
    transport?: NativeVoiceTransport;
}
/** Native complete-utterance audio in / PCM out. This HTTP transport is not a Live duplex socket. */
export declare function useNativeRouterVoice(options: Options): {
    connected: boolean;
    connecting: boolean;
    hasMicrophone: boolean;
    phase: Phase;
    muted: boolean;
    error: string;
    audioLevel: number;
    connect: (withMicrophone?: boolean) => Promise<void>;
    disconnect: () => void;
    interrupt: (hold?: boolean) => void;
    toggleMute: () => void;
    sendText: (text: string) => boolean;
    sendTaskResult: (taskId: string, expectedOwner?: symbol) => boolean;
    getSessionOwner: () => symbol | null;
    resetAccountContext: () => void;
    setPersona: (avatar: AvatarId) => void;
    clearError: () => void;
};
