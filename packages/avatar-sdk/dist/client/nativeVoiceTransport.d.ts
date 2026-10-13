export type AvatarVoiceEndpoint = 'voice' | 'native-turn' | 'native-input' | 'native-observe' | 'native-played' | 'native-reset' | 'native-result' | 'native-result-receipt';
/** Host-owned transport. scopeKey identifies principal/session/workspace/revocation,
 * never a bearer credential. request must preserve its captured identity and signal. */
export interface NativeVoiceTransport {
    readonly scopeKey: string;
    readonly workletUrl: string;
    request(endpoint: AvatarVoiceEndpoint, init: RequestInit): Promise<Response>;
}
export declare const voiceHeaders: () => {
    'Content-Type': string;
    'x-flujo-avatar-client': string;
};
export declare const localNativeVoiceTransport: NativeVoiceTransport;
/** Capture the callback and public transport identity once per voice connection. */
export declare function snapshotNativeVoiceTransport(value?: NativeVoiceTransport): NativeVoiceTransport;
export declare function resetNativeHistory(transport: NativeVoiceTransport, signal: AbortSignal): Promise<void>;
