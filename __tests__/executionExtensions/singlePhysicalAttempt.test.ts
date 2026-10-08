import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { FallbackAdapter } from '@/backend/services/model/adapters/fallbackAdapter';
import { executionExtensionSinglePhysicalAttempt, registerExecutionExtension, type ExecutionExtensionContext, type ExecutionModelIdentity } from '@/backend/execution/extensions';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { Model } from '@/shared/types/model';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';

// The real installed SDK keeps its default maxRetries=2. Only production policy
// request options can suppress its hidden network retries in this fixture.
describe('authenticated single physical OpenAI attempt', () => {
  let server: Server;
  let baseUrl: string;
  let physicalRequests: number;
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  let restore: (() => void) | undefined;
  const run = () => {
    const privateRun = fixtureRun();
    const adapter = fixtureAdapter({ modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }) });
    restore = registerExecutionExtension(adapter);
    return { context: mintFixture(adapter, privateRun), privateRun, adapter };
  };
  const model = (): Model => ({ id: 'fixture-model', name: 'fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl });
  const input = (context?: ExecutionExtensionContext): CompletionInput => ({
    model: model(), apiKey: 'loopback-fixture-not-a-provider-key', messages: [{ role: 'user', content: 'private fixture' }],
    ...(context ? { executionExtensionContext: context } : {}),
  });
  const failure = (response: ServerResponse, status = 503, message = 'Service unavailable') => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    response.end(JSON.stringify({ error: { message, type: 'fixture_error', code: 'fixture' } }));
  };
  const success = (response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'OK', refusal: null } }] }));
  };
  beforeEach(async () => {
    physicalRequests = 0;
    respond = (_request, response) => failure(response);
    server = createServer((request, response) => {
      // Count a physical POST received by the loopback endpoint, independently
      // of the SDK observer and adapter invocation count.
      physicalRequests += 1;
      request.resume();
      respond(request, response);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterEach(async () => {
    restore?.(); restore = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    jest.restoreAllMocks();
  });

  it.each(['response', 'stream'] as const)('sends one physical %s request on HTTP 503 with one SDK marker', async mode => {
    const { context } = run();
    const request = input(context);
    request.onSdkRequest = jest.fn(async () => 'dispatch-1');
    request.onSdkRequestResult = jest.fn(async () => undefined);
    request.onProviderAttempt = jest.fn();
    const adapter = new OpenAiAdapter();
    await expect(mode === 'stream' ? adapter.createStreamCompletion(request) : adapter.createCompletion(request)).rejects.toMatchObject({ status: 503 });
    expect(physicalRequests).toBe(1);
    expect(request.onSdkRequest).toHaveBeenCalledTimes(1);
    expect(request.onSdkRequestResult).toHaveBeenCalledWith({ dispatchId: 'dispatch-1', outcome: 'error' });
    if (mode === 'response') expect(request.onProviderAttempt).toHaveBeenCalledTimes(1);
  });

  it('does not replay a POST whose response is lost after the endpoint receives it', async () => {
    respond = request => request.socket.destroy();
    const { context } = run();
    await expect(new OpenAiAdapter().createCompletion(input(context))).rejects.toThrow();
    expect(physicalRequests).toBe(1);
  });

  it.each([307, 308])('does not resend an inference POST after a %i redirect', async status => {
    respond = (request, response) => {
      if (request.url?.endsWith('/redirected')) success(response);
      else { response.writeHead(status, { Location: '/v1/redirected' }); response.end(); }
    };
    const { context } = run();
    await expect(new OpenAiAdapter().createCompletion(input(context))).rejects.toThrow();
    expect(physicalRequests).toBe(1);
  });

  it('preserves ordinary redirect handling', async () => {
    respond = (request, response) => {
      if (request.url?.endsWith('/redirected')) success(response);
      else { response.writeHead(307, { Location: '/v1/redirected' }); response.end(); }
    };
    expect((await new OpenAiAdapter().createCompletion(input())).completion.choices[0].message.content).toBe('OK');
    expect(physicalRequests).toBe(2);
  });

  it.each(['response', 'stream'] as const)('does not renegotiate cache options in restricted %s mode', async mode => {
    respond = (_request, response) => failure(response, 400, 'Unknown parameter: prompt_cache_key');
    const { context } = run();
    const request = { ...input(context), promptCacheKey: 'fixture-cache-key' };
    const adapter = new OpenAiAdapter();
    await expect(mode === 'stream' ? adapter.createStreamCompletion(request) : adapter.createCompletion(request)).rejects.toMatchObject({ status: 400 });
    expect(physicalRequests).toBe(1);
  });

  it('preserves ordinary SDK retries and demonstrates why a SDK invocation marker is not a physical-attempt count', async () => {
    respond = (_request, response) => physicalRequests === 1 ? failure(response) : success(response);
    const request = input();
    request.onSdkRequest = jest.fn(async () => 'ordinary-dispatch');
    expect((await new OpenAiAdapter().createCompletion(request)).completion.choices[0].message.content).toBe('OK');
    expect(physicalRequests).toBe(2);
    expect(request.onSdkRequest).toHaveBeenCalledTimes(1);
  });

  it('does not accept a public retry flag or a copied policy as original authority', async () => {
    respond = (_request, response) => physicalRequests === 1 ? failure(response) : success(response);
    const request = { ...input(), singlePhysicalAttempt: true, modelAttemptPolicy: { version: 1, maxPhysicalAttempts: 1 } };
    await new OpenAiAdapter().createCompletion(request);
    expect(physicalRequests).toBe(2);
  });

  it('rejects forged and serialized contexts before any network dispatch', async () => {
    const { context } = run();
    for (const forged of [{}, { modelAttemptPolicy: { version: 1, maxPhysicalAttempts: 1 } }, JSON.parse(JSON.stringify(context))]) {
      await expect(new OpenAiAdapter().createCompletion(input(forged as ExecutionExtensionContext)))
        .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    }
    expect(physicalRequests).toBe(0);
  });

  it('rechecks revocation after a durable marker callback and before network dispatch', async () => {
    const { context, privateRun } = run();
    const request = input(context);
    request.onSdkRequest = async () => { privateRun.revoked = true; return 'blocked-intent'; };
    request.onSdkRequestResult = jest.fn(async () => undefined);
    await expect(new OpenAiAdapter().createCompletion(request)).rejects.toMatchObject({ code: 'fixture_authorization_denied' });
    expect(physicalRequests).toBe(0);
    expect(request.onSdkRequestResult).toHaveBeenCalledWith({ dispatchId: 'blocked-intent', outcome: 'error' });
  });

  it('honors the original owner abort signal without a public caller signal', async () => {
    const abort = new AbortController();
    const adapter = fixtureAdapter({ modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }), signal: () => abort.signal });
    restore = registerExecutionExtension(adapter);
    const request = input(mintFixture(adapter));
    request.onSdkRequest = async () => { abort.abort(); return 'cancelled-intent'; };
    await expect(new OpenAiAdapter().createCompletion(request)).rejects.toThrow();
    expect(physicalRequests).toBe(0);
  });

  it('rechecks a changed owner policy after archival and denies dispatch', async () => {
    let restricted = true;
    const adapter = fixtureAdapter({ modelAttemptPolicy: () => restricted ? { version: 1, maxPhysicalAttempts: 1 } : undefined });
    restore = registerExecutionExtension(adapter);
    const request = input(mintFixture(adapter));
    request.onSdkRequest = async () => { restricted = false; return 'changed-policy-intent'; };
    await expect(new OpenAiAdapter().createCompletion(request)).rejects.toMatchObject({ code: 'execution_model_attempt_policy_changed' });
    expect(physicalRequests).toBe(0);
  });

  it('gives the owner only model/endpoint identity, excluding provider credentials', async () => {
    const policy = jest.fn((_context: object, _model: ExecutionModelIdentity) => ({ version: 1 as const, maxPhysicalAttempts: 1 as const }));
    const adapter = fixtureAdapter({ modelAttemptPolicy: policy });
    restore = registerExecutionExtension(adapter);
    await expect(new OpenAiAdapter().createCompletion(input(mintFixture(adapter)))).rejects.toMatchObject({ status: 503 });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(policy.mock.calls[0][1]).toEqual({ id: 'fixture-model', name: 'fixture', provider: 'openai', adapter: 'openai', baseUrl });
    expect(physicalRequests).toBe(1);
  });

  it('rejects unsupported adapters/fallback before resolving a member or making a request', async () => {
    const { context } = run();
    await expect(executionExtensionSinglePhysicalAttempt(context, { ...model(), adapter: 'openai-responses' }))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    const adapterFor = jest.fn();
    await expect(new FallbackAdapter(adapterFor).createCompletion({ ...input(context),
      model: { ...model(), fallbackPolicy: { modelIds: ['first', 'second'] } } }))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    expect(adapterFor).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it('rejects an invalid policy and adapter replacement while an async attestation is pending', async () => {
    const invalid = fixtureAdapter({ modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 2 }) as never });
    restore = registerExecutionExtension(invalid);
    await expect(new OpenAiAdapter().createCompletion(input(mintFixture(invalid))))
      .rejects.toMatchObject({ code: 'execution_model_attempt_policy_invalid' });
    let restoreReplacement: (() => void) | undefined;
    const adapter = fixtureAdapter({ modelAttemptPolicy: async () => {
      restoreReplacement = registerExecutionExtension(fixtureAdapter());
      return { version: 1, maxPhysicalAttempts: 1 };
    } });
    restore(); restore = registerExecutionExtension(adapter);
    try {
      await expect(new OpenAiAdapter().createCompletion(input(mintFixture(adapter))))
        .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    } finally { restoreReplacement?.(); }
    expect(physicalRequests).toBe(0);
  });
});
