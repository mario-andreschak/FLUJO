export { useNativeRouterVoice } from '../client/useNativeRouterVoice.js';
export type NativeVoiceOptions = Parameters<typeof import('../client/useNativeRouterVoice.js').useNativeRouterVoice>[0];
export { voiceHeaders, snapshotNativeVoiceTransport, localNativeVoiceTransport } from '../client/nativeVoiceTransport.js';
export type { NativeVoiceTransport, AvatarVoiceEndpoint } from '../client/nativeVoiceTransport.js';
export { usePocketSpeech } from '../client/usePocketSpeech.js';
export type { PocketResult } from '../client/usePocketSpeech.js';
export { DEFAULT_LOCALE, normalizeLocale } from '../client/locale.js';
export type { Locale } from '../client/locale.js';
