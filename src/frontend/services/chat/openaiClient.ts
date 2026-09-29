import OpenAI from 'openai';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';

/** The built-in chat calls its own origin; the backend supplies provider auth. */
export function createSameOriginChatClient(origin: string, fetchImpl?: typeof fetch): OpenAI {
  return new OpenAI({
    baseURL: new URL(origin).origin + '/v1',
    // The SDK requires a constructor credential even for an unauthenticated
    // local API. Omit that placeholder header; explicit request headers still
    // take precedence, so caller-provided credentials remain intact.
    apiKey: 'FLUJO',
    defaultHeaders: { Authorization: null },
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    // A graphical flow can run longer than a typical provider HTTP request.
    timeout: LLM_REQUEST_TIMEOUT_MS,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
