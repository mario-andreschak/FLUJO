import type { Locale } from './locale';
const es = {
  browserRequired: 'La voz necesita acceso al micrófono en una conexión segura. Puedes escribir.',
  playbackBlocked: 'Activa el sonido para escuchar la voz.', microphoneDenied: 'Habilita el micrófono o usa el teclado.',
  streamFailed: 'La voz se interrumpió. Puedes volver a conectarte o escribir.', unsupportedAudio: 'El audio no es compatible.',
  speechUnrecognized: 'No pude reconocer lo que dijiste. Intenta de nuevo.', recordingTooLong: 'Hablemos en frases de menos de 25 segundos.',
  messageTooLong: 'Usa mensajes de menos de 4000 caracteres.', providerUnavailable: 'La voz no está disponible. Puedes escribir.',
};
const pt: typeof es = {
  browserRequired: 'A voz precisa de acesso ao microfone em uma conexão segura. Você pode escrever.',
  playbackBlocked: 'Ative o som para ouvir a voz.', microphoneDenied: 'Ative o microfone ou use o teclado.',
  streamFailed: 'A voz foi interrompida. Você pode conectar novamente ou escrever.', unsupportedAudio: 'O áudio não é compatível.',
  speechUnrecognized: 'Não reconheci o que você disse. Tente novamente.', recordingTooLong: 'Vamos falar em frases de menos de 25 segundos.',
  messageTooLong: 'Use mensagens com menos de 4000 caracteres.', providerUnavailable: 'A voz está indisponível. Você pode escrever.',
};
const en: typeof es = {
  browserRequired: 'Voice needs microphone access on a secure connection. You can type.',
  playbackBlocked: 'Enable sound to hear the voice.', microphoneDenied: 'Enable the microphone or use text.',
  streamFailed: 'Voice was interrupted. Reconnect or use text.', unsupportedAudio: 'The audio format is incompatible.',
  speechUnrecognized: 'I couldn’t recognize that. Try again.', recordingTooLong: 'Use phrases shorter than 25 seconds.',
  messageTooLong: 'Use messages shorter than 4000 characters.', providerUnavailable: 'Voice is unavailable. You can type.',
};
export function voiceCopy(locale: Locale) { return ({ es, pt, en })[locale]; }
export class VoiceLocaleError extends Error { constructor(readonly key: keyof typeof es) { super(key); } }
export function voiceError(locale: Locale, error: unknown, fallback: keyof typeof es = 'providerUnavailable') {
  return voiceCopy(locale)[error instanceof VoiceLocaleError ? error.key : fallback];
}
export function voiceRequestError(_status: number, _code: unknown) { return new VoiceLocaleError('providerUnavailable'); }
export async function voiceResponseError(response: Response) {
  await response.body?.cancel(); return new VoiceLocaleError('providerUnavailable');
}
