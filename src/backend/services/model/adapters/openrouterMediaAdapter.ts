import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { getProviderDefaultHeaders } from '../openaiClient';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { extractImageParts, extractText } from './messageUtils';
import { resolveOpenRouterMediaRoute } from './openrouterMediaRouting';

const log = createLogger('backend/services/model/adapters/openrouterMediaAdapter');
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const VIDEO_POLL_INTERVAL_MS = 5_000;

type VideoJob = {
  id?: string;
  polling_url?: string;
  status?: string;
  generation_id?: string;
  unsigned_urls?: string[];
  error?: unknown;
  usage?: Record<string, unknown>;
};

type ImageResponse = {
  created?: number;
  data?: Array<{
    b64_json?: string;
    url?: string;
    media_type?: string;
    mime_type?: string;
  }>;
  usage?: OpenAI.Completions.CompletionUsage;
  error?: unknown;
};

function endpoint(baseUrl: string | undefined, resource: 'images' | 'videos'): URL {
  const base = (baseUrl?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, '');
  return new URL(`${base}/${resource}`);
}

function latestUserPrompt(messages: OpenAI.ChatCompletionMessageParam[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  throw new Error('OpenRouter media generation requires a non-empty user prompt.');
}

function latestReferenceImage(messages: OpenAI.ChatCompletionMessageParam[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const images = extractImageParts(message.content);
    if (images.length > 0) return images[images.length - 1].url;
  }
  return undefined;
}

function completion(
  model: string,
  id: string,
  media: ModelMediaPart[],
  usage?: OpenAI.Completions.CompletionUsage,
): CompletionResult {
  return {
    media,
    completion: {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
        },
      }],
      ...(usage ? { usage } : {}),
    },
  };
}

function safeErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, any>;
    if (typeof candidate.message === 'string') return candidate.message;
    if (typeof candidate.error?.message === 'string') return candidate.error.message;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const NO_ENDPOINT_PATTERN = /no (endpoint|allowed providers)|not found|unknown route/i;

async function responseError(
  response: Response,
  model: CompletionInput['model'],
  resource: 'images' | 'videos',
): Promise<Error> {
  let detail = response.statusText || `HTTP ${response.status}`;
  try {
    const body = await response.json();
    detail = safeErrorText((body as { error?: unknown }).error ?? body) || detail;
  } catch {
    try {
      detail = (await response.text()).trim() || detail;
    } catch {
      // Keep the status text fallback.
    }
  }
  if (response.status === 404 || NO_ENDPOINT_PATTERN.test(detail)) {
    return new Error(
      `OpenRouter has no dedicated /${resource} route for "${model.name}". This model is served by ` +
      `/chat/completions — remove "image"/"video" from its output modalities or re-sync the model ` +
      `from the OpenRouter catalogue (Models → Fetch models). (provider detail: ${detail})`,
    );
  }
  return new Error(`OpenRouter media API returned ${response.status}: ${detail}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function observedFetch(
  url: URL,
  init: RequestInit,
  input: CompletionInput,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: input.signal });
    input.onProviderAttempt?.({
      attempt: 1,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: 'completed',
      result: { status: response.status },
    });
    return response;
  } catch (error) {
    input.onProviderAttempt?.({
      attempt: 1,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: input.signal?.aborted ? 'cancelled' : 'error',
      error,
    });
    throw error;
  }
}

function requestHeaders(input: CompletionInput): Record<string, string> {
  return {
    Authorization: `Bearer ${input.apiKey}`,
    'Content-Type': 'application/json',
    ...(getProviderDefaultHeaders('openrouter') ?? {}),
  };
}

async function generateImage(input: CompletionInput): Promise<CompletionResult> {
  const url = endpoint(input.model.baseUrl, 'images');
  const prompt = latestUserPrompt(input.messages);
  const referenceImage = latestReferenceImage(input.messages);
  const response = await observedFetch(url, {
    method: 'POST',
    headers: requestHeaders(input),
    body: JSON.stringify({
      model: input.model.name,
      prompt,
      ...(referenceImage
        ? {
            input_references: [{
              type: 'image_url',
              image_url: { url: referenceImage },
            }],
          }
        : {}),
    }),
  }, input);
  if (!response.ok) throw await responseError(response, input.model, 'images');
  const body = await response.json() as ImageResponse;
  if (body.error) throw new Error(`OpenRouter image generation failed: ${safeErrorText(body.error)}`);
  const media: ModelMediaPart[] = (body.data ?? []).flatMap((item): ModelMediaPart[] => {
    const mimeType = item.media_type ?? item.mime_type ?? 'image/png';
    if (item.b64_json) {
      return [{ type: 'image', data: item.b64_json, mimeType }];
    }
    if (item.url) {
      return [{ type: 'image', url: item.url, mimeType }];
    }
    return [];
  });
  if (media.length === 0) {
    throw new Error('OpenRouter image generation completed without an image.');
  }
  return completion(
    input.model.name,
    `openrouter-image-${uuidv4()}`,
    media,
    body.usage,
  );
}

function trustedPollingUrl(job: VideoJob, apiUrl: URL): URL {
  const fallback = job.id ? new URL(`videos/${encodeURIComponent(job.id)}`, `${apiUrl.origin}/api/v1/`) : undefined;
  const resolved = job.polling_url ? new URL(job.polling_url, apiUrl) : fallback;
  if (!resolved || resolved.origin !== apiUrl.origin) {
    throw new Error('OpenRouter returned an invalid cross-origin video polling URL.');
  }
  return resolved;
}

function videoContentFallback(job: VideoJob, apiUrl: URL): URL {
  if (!job.id) throw new Error('OpenRouter video job completed without a job id.');
  return new URL(
    `videos/${encodeURIComponent(job.id)}/content?index=0`,
    `${apiUrl.origin}/api/v1/`,
  );
}

function downloadHeaders(url: URL, apiUrl: URL, apiKey: string): Record<string, string> | undefined {
  // unsigned_urls may point at third-party object storage. Never leak the
  // OpenRouter credential away from the configured API origin.
  return url.origin === apiUrl.origin
    ? { Authorization: `Bearer ${apiKey}` }
    : undefined;
}

async function downloadVideo(
  job: VideoJob,
  apiUrl: URL,
  input: CompletionInput,
): Promise<ModelMediaPart> {
  const fallback = videoContentFallback(job, apiUrl);
  const preferred = job.unsigned_urls?.[0]
    ? new URL(job.unsigned_urls[0], apiUrl)
    : fallback;
  if (!['http:', 'https:'].includes(preferred.protocol)) {
    throw new Error('OpenRouter returned an unsupported video download URL.');
  }

  const candidates =
    preferred.href === fallback.href ? [preferred] : [preferred, fallback];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const response = await observedFetch(candidate, {
        headers: downloadHeaders(candidate, apiUrl, input.apiKey),
      }, input);
      if (!response.ok) {
        lastError = await responseError(response, input.model, 'videos');
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) {
        lastError = new Error('OpenRouter returned an empty video file.');
        continue;
      }
      const mimeType =
        response.headers.get('content-type')?.split(';')[0].trim() || 'video/mp4';
      return { type: 'video', data: bytes.toString('base64'), mimeType };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to download the generated OpenRouter video.');
}

async function generateVideo(input: CompletionInput): Promise<CompletionResult> {
  const apiUrl = endpoint(input.model.baseUrl, 'videos');
  const prompt = latestUserPrompt(input.messages);
  const referenceImage = latestReferenceImage(input.messages);
  const response = await observedFetch(apiUrl, {
    method: 'POST',
    headers: requestHeaders(input),
    body: JSON.stringify({
      model: input.model.name,
      prompt,
      ...(referenceImage
        ? {
            frame_images: [{
              type: 'image_url',
              image_url: { url: referenceImage },
              frame_type: 'first_frame',
            }],
          }
        : {}),
    }),
  }, input);
  if (!response.ok) throw await responseError(response, input.model, 'videos');
  let job = await response.json() as VideoJob;
  if (job.error && job.status !== 'completed') {
    throw new Error(`OpenRouter video generation failed: ${safeErrorText(job.error)}`);
  }
  const pollingUrl = trustedPollingUrl(job, apiUrl);

  while (!['completed', 'failed', 'cancelled', 'expired'].includes(job.status ?? 'pending')) {
    const poll = await observedFetch(pollingUrl, {
      headers: requestHeaders(input),
    }, input);
    if (!poll.ok) throw await responseError(poll, input.model, 'videos');
    job = await poll.json() as VideoJob;
    if (!['completed', 'failed', 'cancelled', 'expired'].includes(job.status ?? 'pending')) {
      await delay(VIDEO_POLL_INTERVAL_MS, input.signal);
    }
  }

  if (job.status !== 'completed') {
    throw new Error(
      `OpenRouter video generation ${job.status ?? 'failed'}: ${safeErrorText(job.error ?? 'Unknown provider error')}`,
    );
  }
  const media = await downloadVideo(job, apiUrl, input);
  return completion(
    input.model.name,
    job.generation_id ?? job.id ?? `openrouter-video-${uuidv4()}`,
    [media],
  );
}

/**
 * OpenRouter's image/video output models use dedicated media endpoints rather
 * than `/chat/completions`. Video jobs are asynchronous and are polled until a
 * terminal state; both endpoints are normalized back to CompletionResult.
 */
export class OpenRouterMediaAdapter implements CompletionAdapter {
  async createCompletion(input: CompletionInput): Promise<CompletionResult> {
    const route = resolveOpenRouterMediaRoute(input.model);
    if (route.kind === 'videos') return generateVideo(input);
    if (route.kind === 'images') return generateImage(input);
    throw new Error(
      `OpenRouter media adapter selected for a model without a dedicated media route (${route.reason}).`,
    );
  }

  async createStreamCompletion(input: CompletionInput): Promise<CompletionResult> {
    const liveMessageId = `stream_${uuidv4()}`;
    const isVideo = resolveOpenRouterMediaRoute(input.model).kind === 'videos';
    input.onModelDelta?.({
      messageId: liveMessageId,
      contentDelta: isVideo ? 'Generating video…' : 'Generating image…',
    });
    log.debug('Started OpenRouter dedicated media generation', {
      model: input.model.name,
      output: isVideo ? 'video' : 'image',
    });
    return {
      ...(await this.createCompletion(input)),
      liveMessageId,
    };
  }
}
