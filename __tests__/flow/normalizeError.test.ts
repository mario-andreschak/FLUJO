/**
 * Issue #383 ("Chat Error Code"): unit tests for the single normalizer that
 * shapes every error surfaced on the chat error path (SSE `error` event,
 * persisted `lastError`, and the chat-completions error envelope).
 */
import {
  normalizeChatError,
  redactErrorDetails,
  deriveLastErrorFromLastResponse,
  emitErrorOnce,
} from '@/backend/execution/flow/normalizeError';
import type { SharedState } from '@/backend/execution/flow/types';

function makeSharedState(): SharedState {
  return {
    conversationId: 'conv-1',
    flowId: 'flow-1',
    trackingInfo: { executionId: 'exec-1', startTime: Date.now(), nodeExecutionTracker: [] },
    messages: [],
  } as unknown as SharedState;
}

describe('normalizeChatError', () => {
  it('maps provider details (status/code/type/retryAfter) and classifies rate_limit', () => {
    const err = Object.assign(new Error('429 Provider returned error'), {
      details: {
        status: 429,
        code: 'rate_limit_exceeded',
        type: 'rate_limit_error',
        retryAfter: '30',
      },
    });
    const norm = normalizeChatError(err);
    expect(norm.message).toBe('429 Provider returned error');
    expect(norm.httpStatus).toBe(429);
    expect(norm.code).toBe('rate_limit_exceeded');
    expect(norm.providerType).toBe('rate_limit_error');
    expect(norm.retryAfter).toBe('30');
    expect(norm.errorClass).toBe('rate_limit');
    expect(typeof norm.occurredAt).toBe('number');
  });

  it('handles a plain Error with no details safely, classifying as unknown', () => {
    const norm = normalizeChatError(new Error('Something went wrong'));
    expect(norm.message).toBe('Something went wrong');
    expect(norm.code).toBeUndefined();
    expect(norm.httpStatus).toBeUndefined();
    expect(norm.errorClass).toBe('unknown');
  });

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('does not throw for a non-Error value (%s)', (_label, value) => {
    expect(() => normalizeChatError(value)).not.toThrow();
    const norm = normalizeChatError(value);
    expect(typeof norm.message).toBe('string');
    expect(norm.message.length).toBeGreaterThan(0);
  });

  it('redacts authorization headers, api keys, and sk- style secrets from providerError', () => {
    const err = Object.assign(new Error('Upstream rejected the request'), {
      details: {
        status: 401,
        providerError: {
          message: 'Invalid API key',
          headers: { authorization: 'Bearer sk-abcdefgh12345678', 'x-api-key': 'sk-secretsecret1234' },
          hint: 'Use key sk-liveSECRET1234567 instead',
        },
      },
    });
    const norm = normalizeChatError(err);
    expect(norm.details).toBeDefined();
    const serialized = JSON.stringify(norm.details);
    expect(serialized).not.toContain('sk-abcdefgh12345678');
    expect(serialized).not.toContain('sk-secretsecret1234');
    expect(serialized).not.toContain('sk-liveSECRET1234567');
    const headers = norm.details!.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[REDACTED]');
    expect(headers['x-api-key']).toBe('[REDACTED]');
  });

  it('caps an oversized providerError body below the size limit', () => {
    const huge = { blob: 'x'.repeat(20_000) };
    const redacted = redactErrorDetails(huge);
    expect(redacted).toBeDefined();
    expect(JSON.stringify(redacted).length).toBeLessThan(9 * 1024);
  });
});

describe('deriveLastErrorFromLastResponse (back-compat fallback)', () => {
  it('derives a NormalizedChatError from a legacy { success:false, error, errorDetails } shape', () => {
    const derived = deriveLastErrorFromLastResponse({
      success: false,
      error: '429 rate limited',
      errorDetails: { message: '429 rate limited', status: 429, code: 'rate_limit_exceeded' },
    });
    expect(derived?.message).toBe('429 rate limited');
    expect(derived?.httpStatus).toBe(429);
    expect(derived?.errorClass).toBe('rate_limit');
  });

  it('returns undefined when there is no error to derive', () => {
    expect(deriveLastErrorFromLastResponse(undefined)).toBeUndefined();
    expect(deriveLastErrorFromLastResponse('some plain text response')).toBeDefined();
    expect(deriveLastErrorFromLastResponse({ success: true })).toBeUndefined();
  });
});

describe('emitErrorOnce dedupe guard', () => {
  it('emits exactly one error event per run even when called multiple times', () => {
    const sharedState = makeSharedState();
    const emit = jest.fn();
    emitErrorOnce(sharedState, emit, new Error('first failure'));
    emitErrorOnce(sharedState, emit, new Error('second failure (should be ignored)'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(sharedState.lastError?.message).toBe('first failure');
  });

  it('sets SharedState.lastError even when no emit function is provided', () => {
    const sharedState = makeSharedState();
    emitErrorOnce(sharedState, undefined, new Error('no emitter'));
    expect(sharedState.lastError?.message).toBe('no emitter');
    expect(sharedState.errorEventEmitted).toBe(true);
  });
});

describe('normalized top-level credential masking', () => {
  describe.each([
    ['API key', 'sk-normalizedSECRET12345678', '[REDACTED]'],
    ['bearer token', 'bEaReR session-token-12345678', 'Bearer [REDACTED]'],
  ])('%s', (_label, credential, replacement) => {
    it.each<[string, (message: string) => unknown]>([
      ['Error.message', (message: string) => new Error(message)],
      ['string', (message: string) => message],
      ['object.message', (message: string) => ({ message })],
      ['String fallback', (message: string) => ({ toString: () => message })],
    ])('masks credentials from %s without discarding the reason', (_shape, makeError) => {
      const norm = normalizeChatError(makeError('Provider refused credential ' + credential + '; retry later.'));
      expect(norm.message).toBe('Provider refused credential ' + replacement + '; retry later.');
      expect(JSON.stringify(norm)).not.toContain(credential);
    });
  });

  it.each(['string', 'record'] as const)('masks a legacy %s error on readback', shape => {
    const raw = 'Rejected sk-legacySECRET12345678 and Bearer legacy-token-12345678.';
    const response = shape === 'string' ? raw : { success: false, error: raw };
    const derived = deriveLastErrorFromLastResponse(response);
    expect(derived?.message).toBe('Rejected [REDACTED] and Bearer [REDACTED]');
    expect(JSON.stringify(derived)).not.toContain('sk-legacySECRET12345678');
    expect(JSON.stringify(derived)).not.toContain('legacy-token-12345678');
  });

  it('persists and emits a masked error once while preserving error metadata', () => {
    const sharedState = makeSharedState();
    const emit = jest.fn();
    const raw = 'Rejected sk-emittedSECRET12345678 and Bearer emitted-token-12345678.';
    const err = Object.assign(new Error(raw), {
      details: { status: 429, code: 'rate_limit_exceeded', type: 'rate_limit_error', retryAfter: '7' },
    });
    const norm = emitErrorOnce(sharedState, emit, err, { nodeId: 'model', nodeName: 'Model' });
    emitErrorOnce(sharedState, emit, err);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(sharedState.lastError).toBe(norm);
    expect(norm).toMatchObject({
      message: 'Rejected [REDACTED] and Bearer [REDACTED]',
      httpStatus: 429, code: 'rate_limit_exceeded', providerType: 'rate_limit_error',
      retryAfter: '7', errorClass: 'rate_limit', nodeId: 'model', nodeName: 'Model',
    });
    expect(emit.mock.calls[0][0]).toMatchObject({ type: 'error', message: norm?.message, error: norm });
    const servedAndPersisted = JSON.stringify({ events: emit.mock.calls, lastError: sharedState.lastError });
    expect(servedAndPersisted).not.toContain('sk-emittedSECRET12345678');
    expect(servedAndPersisted).not.toContain('emitted-token-12345678');
    expect(err.message).toBe(raw);
  });
});
