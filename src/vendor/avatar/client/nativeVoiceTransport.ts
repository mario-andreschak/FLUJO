import { voiceResponseError } from './voiceLocale';

export type AvatarVoiceEndpoint = 'voice' | 'native-turn' | 'native-input' | 'native-observe'
  | 'native-played' | 'native-reset' | 'native-result' | 'native-result-receipt';

/** Host-owned transport. scopeKey identifies principal/session/workspace/revocation,
 * never a bearer credential. request must preserve its captured identity and signal. */
export interface NativeVoiceTransport {
  readonly scopeKey: string;
  readonly workletUrl: string;
  request(endpoint: AvatarVoiceEndpoint, init: RequestInit): Promise<Response>;
}

const clientId = () => {
  const key = 'flujo-avatar:voice-client';
  let id = sessionStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
  return id;
};
export const voiceHeaders = () => ({ 'Content-Type': 'application/json', 'x-flujo-avatar-client': clientId() });

export const localNativeVoiceTransport: NativeVoiceTransport = Object.freeze({
  scopeKey: 'local-native-voice', workletUrl: '/avatar-audio-capture.js',
  request: (endpoint: AvatarVoiceEndpoint, init: RequestInit) => fetch(`/api/avatar/${endpoint}`, init),
});

/** Capture the callback and public transport identity once per voice connection. */
export function snapshotNativeVoiceTransport(value: NativeVoiceTransport = localNativeVoiceTransport): NativeVoiceTransport {
  if (typeof value.scopeKey !== 'string' || !value.scopeKey || value.scopeKey.length > 512
    || typeof value.workletUrl !== 'string' || !value.workletUrl || value.workletUrl.length > 2048
    || typeof value.request !== 'function') throw new Error('invalid_voice_transport');
  const request = value.request.bind(value);
  return Object.freeze({ scopeKey: value.scopeKey, workletUrl: value.workletUrl, request });
}

// A failed/disconnected owner cannot block another identity's reset or erase its history.
const resetBarriers = new Map<string, Promise<void>>();
export function resetNativeHistory(transport: NativeVoiceTransport, signal: AbortSignal): Promise<void> {
  const next = (resetBarriers.get(transport.scopeKey) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const owned = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    owned.throwIfAborted();
    const response = await transport.request('native-reset', {
      method: 'POST', headers: voiceHeaders(), body: '{}', signal: owned,
    });
    if (owned.aborted) { await response.body?.cancel(); owned.throwIfAborted(); }
    if (!response.ok) throw await voiceResponseError(response);
    await response.body?.cancel();
  });
  const settled = next.catch(() => {});
  resetBarriers.set(transport.scopeKey, settled);
  void settled.then(() => { if (resetBarriers.get(transport.scopeKey) === settled) resetBarriers.delete(transport.scopeKey); });
  return next;
}
