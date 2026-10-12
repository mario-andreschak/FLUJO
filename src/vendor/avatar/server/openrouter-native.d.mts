export interface NativeResult { completed: boolean; text?: string; samples?: number; code?: string; usage?: Record<string, unknown> }
export interface NativeValue { message?: string; audio?: string; format?: 'wav'; avatar: string; locale: string }
export interface NativeContext {
  turnId: string;
  history?: Array<{ role: string; content: string }>;
  backendResult?: { reply: string; mode?: string; status?: string };
  setupFacts?: string;
  onQualifiedResult?: (result: NativeResult) => unknown;
}
export const NATIVE_AUDIO: Readonly<{ model: string; voice: string; endpoint: string; sampleRate: number; sampleRateQualification: string; timeoutMs: number }>;
export function validateNativeTurn(payload: unknown): NativeValue;
export function streamNativeTurn(payload: unknown, config: { openrouterKey: string }, fetchImpl: typeof fetch, signal: AbortSignal, emit: (event: unknown) => Promise<void> | void, context: NativeContext): Promise<NativeResult>;
