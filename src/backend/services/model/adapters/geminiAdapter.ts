import { GoogleGenAI, type Interactions } from '@google/genai';
import { CompletionAdapter, CompletionInput, CompletionResult, observeSdkRequest, assertReadOnlyAssessmentInput } from './types';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { assertOwnerCredentialAdapterRoute } from '@/backend/execution/extensions';
import { interactionRequest, interactionResult, readInteractionStream } from './geminiInteractions';

// Retain the media/schema translation exports used by other adapters and fixtures.
export { toGeminiContents, toGeminiTools } from './geminiMessages';

/** Gemini Native uses stateless Interactions; FLUJO alone executes function tools. */
export class GeminiAdapter implements CompletionAdapter {
  async createCompletion(input: CompletionInput): Promise<CompletionResult> {
    assertOwnerCredentialAdapterRoute(input.model, 'gemini');
    assertReadOnlyAssessmentInput(input);
    if (input.readOnlyAssessment) return this.createAssessment(input);
    const ai = new GoogleGenAI({ apiKey: input.apiKey, httpOptions: { timeout: LLM_REQUEST_TIMEOUT_MS } });
    const request = await interactionRequest(input);
    const response = await observeSdkRequest(input,
      { adapter: 'gemini', operation: 'interactions.create', request },
      () => ai.interactions.create({ ...request, stream: false }, {
        signal: input.signal, timeout_ms: LLM_REQUEST_TIMEOUT_MS, retries: { strategy: 'none' }, redirect: 'error',
      }));
    return interactionResult(input.model, response);
  }

  async createStreamCompletion(input: CompletionInput): Promise<CompletionResult> {
    assertOwnerCredentialAdapterRoute(input.model, 'gemini');
    if (input.readOnlyAssessment) throw new Error('Read-only assessment does not support streaming.');
    const ai = new GoogleGenAI({ apiKey: input.apiKey, httpOptions: { timeout: LLM_REQUEST_TIMEOUT_MS } });
    const request = { ...await interactionRequest(input), stream: true as const };
    const stream = await observeSdkRequest(input,
      { adapter: 'gemini', operation: 'interactions.create(stream)', request },
      () => ai.interactions.create(request, {
        signal: input.signal, timeout_ms: LLM_REQUEST_TIMEOUT_MS, retries: { strategy: 'none' }, redirect: 'error',
      }));
    return readInteractionStream(stream, input);
  }

  private async createAssessment(input: CompletionInput): Promise<CompletionResult> {
    const { model, apiKey, signal } = input;
    // Keep the assessment boundary: one bounded REST request, no redirect,
    // tool, media, retry, background execution or server-side history.
    let base: URL;
    try { base = new URL(model.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'); }
    catch { throw new Error('The saved Gemini endpoint is not supported for read-only assessment.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password
      || base.search || base.hash || !/^\/(?:v1|v1beta2?|v1alpha)\/?$/.test(base.pathname)) {
      throw new Error('The saved Gemini endpoint is not supported for read-only assessment.');
    }
    const name = model.name.replace(/^models\//, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(name)) throw new Error('The saved Gemini model name is not supported for read-only assessment.');
    const endpoint = `${base.origin}${base.pathname.replace(/\/$/, '')}/interactions`;
    const body = { ...await interactionRequest(input), response_modalities: ['text'] };
    const data = await observeSdkRequest(input,
      { adapter: 'gemini', operation: 'interactions.create(readOnlyAssessment)', request: body },
      async () => {
        signal!.throwIfAborted();
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body), signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Gemini assessment response is unavailable.');
        try {
          if (!response.ok || Number(response.headers.get('content-length')) > 128 * 1024) throw new Error();
          let bytes = 0;
          const chunks: Uint8Array[] = [];
          while (true) {
            signal!.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 128 * 1024) throw new Error();
            chunks.push(part.value);
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Interactions.Interaction;
          if (parsed.status !== 'completed' || parsed.errors?.length || !Array.isArray(parsed.steps)
            || !parsed.steps.some(step => step.type === 'model_output')
            || parsed.steps.some(step => step.type === 'thought' ? false : step.type !== 'model_output'
              || step.error || !Array.isArray(step.content) || step.content.some(part => part.type !== 'text'))) throw new Error();
          return parsed;
        } catch {
          if (signal!.aborted) signal!.throwIfAborted();
          throw new Error('Gemini assessment response is unavailable.');
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      });
    return interactionResult(model, data);
  }
}
