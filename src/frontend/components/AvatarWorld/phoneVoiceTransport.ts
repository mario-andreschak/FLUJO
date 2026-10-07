import type { AvatarVoiceEndpoint, NativeVoiceTransport } from '@/vendor/avatar/client/nativeVoiceTransport';
import { isValidWorkspaceName } from '@/frontend/utils/workspaceSelection';

export interface PhoneVoiceSession {
  readonly csrf: string;
  readonly voiceScopeKey: string;
  readonly nativeWorkspace: string;
}

const ACTIONS = new Set<AvatarVoiceEndpoint>([
  'native-turn', 'native-input', 'native-observe', 'native-played',
  'native-reset', 'native-result', 'native-result-receipt',
]);
const ended = () => new DOMException('Phone voice session ended.', 'AbortError');

/** These are public session facts. Neither field authorizes the native worker. */
export function parsePhoneVoiceSession(value: unknown): PhoneVoiceSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('phone_voice_session_unavailable');
  const session = value as Record<string, unknown>;
  if (typeof session.csrf !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(session.csrf)
    || typeof session.voiceScopeKey !== 'string' || !session.voiceScopeKey || session.voiceScopeKey.length > 512
    || !isValidWorkspaceName(session.nativeWorkspace)) {
    throw new Error('phone_voice_session_unavailable');
  }
  return Object.freeze({ csrf: session.csrf, voiceScopeKey: session.voiceScopeKey, nativeWorkspace: session.nativeWorkspace });
}

export async function readPhoneVoiceSession(response: Response): Promise<PhoneVoiceSession> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('phone_voice_session_unavailable'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 8192) throw new Error('phone_voice_session_unavailable');
      chunks.push(item.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return parsePhoneVoiceSession(JSON.parse(new TextDecoder().decode(data)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/** Root serves these fixed relative routes on the full native world's origin. */
export async function createPhoneVoiceTransport(
  value: PhoneVoiceSession,
  lifetime: AbortSignal,
  onAccessEnded: () => void,
  fetchImpl: typeof fetch = fetch,
): Promise<NativeVoiceTransport> {
  const session = parsePhoneVoiceSession(value);
  lifetime.throwIfAborted();
  // CSRF rotation also retires a captured callback, without exposing the token
  // in the public scope key. The BFF remains the authorization authority.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([session.voiceScopeKey, session.nativeWorkspace, session.csrf])));
  const scopeKey = 'phone:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  lifetime.throwIfAborted();
  return Object.freeze({
    scopeKey,
    workletUrl: '/avatar-audio-capture.js',
    async request(endpoint: AvatarVoiceEndpoint, init: RequestInit): Promise<Response> {
      if (endpoint !== 'voice' && !ACTIONS.has(endpoint)) throw new Error('phone_voice_action_unavailable');
      const method = endpoint === 'voice' ? 'GET' : 'POST';
      if ((init.method ?? 'GET').toUpperCase() !== method) throw new Error('phone_voice_method_unavailable');
      const signal = AbortSignal.any([lifetime, ...(init.signal ? [init.signal] : [])]);
      signal.throwIfAborted();
      // No caller auth, workspace or forwarding headers cross this boundary.
      const supplied = new Headers(init.headers);
      const headers = new Headers({ 'x-phone-csrf': session.csrf });
      const client = supplied.get('x-flujo-avatar-client');
      if (client) headers.set('x-flujo-avatar-client', client);
      if (method === 'POST') headers.set('Content-Type', 'application/json');
      const response = await fetchImpl(`/phone/voice/${endpoint === 'voice' ? 'availability' : endpoint}`, {
        method, headers, ...(method === 'POST' ? { body: init.body } : {}),
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      });
      if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw signal.reason ?? ended(); }
      if (response.status === 401 || response.status === 403) onAccessEnded();
      return response;
    },
  });
}

/** Missing phone admission must never select the local loopback transport. */
export const unavailablePhoneVoiceTransport: NativeVoiceTransport = Object.freeze({
  scopeKey: 'phone-voice-session-unavailable', workletUrl: '/avatar-audio-capture.js',
  request: async () => { throw ended(); },
});
