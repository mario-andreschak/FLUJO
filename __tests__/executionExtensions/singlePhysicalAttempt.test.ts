import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { OpenAiResponsesAdapter } from '@/backend/services/model/adapters/openaiResponsesAdapter';
import { OpenRouterMediaAdapter } from '@/backend/services/model/adapters/openrouterMediaAdapter';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import { FallbackAdapter } from '@/backend/services/model/adapters/fallbackAdapter';
import { dispatchExecutionModelRequest, ExecutionExtensionError, executionExtensionSinglePhysicalAttempt, issueExecutionModelStepContext, registerExecutionExtension, type ExecutionExtensionContext, type ExecutionModelIdentity, type ExecutionModelRequestIntent, type ExecutionOwnerModelDispatchRequest } from '@/backend/execution/extensions';
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
    const claimModelRequest = jest.fn(async (_context: object, _intent: ExecutionModelRequestIntent) => undefined);
    const adapter = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
    });
    restore = registerExecutionExtension(adapter);
    return { context: mintFixture(adapter, privateRun), privateRun, adapter, claimModelRequest };
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
      respond(request, response);
      request.resume();
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
    const { context, claimModelRequest } = run();
    const request = input(context);
    request.onSdkRequest = jest.fn(async () => 'dispatch-1');
    request.onSdkRequestResult = jest.fn(async () => undefined);
    request.onProviderAttempt = jest.fn();
    const adapter = new OpenAiAdapter();
    await expect(mode === 'stream' ? adapter.createStreamCompletion(request) : adapter.createCompletion(request)).rejects.toMatchObject({ status: 503 });
    expect(physicalRequests).toBe(1);
    expect(claimModelRequest).toHaveBeenCalledTimes(1);
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

  it('consumes one protected context before any second logical call can send', async () => {
    respond = (_request, response) => success(response);
    const { context, claimModelRequest } = run();
    const adapter = new OpenAiAdapter();
    await adapter.createCompletion(input(context));
    await expect(adapter.createCompletion(input(context)))
      .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
    expect(claimModelRequest).toHaveBeenCalledTimes(1);
    expect(physicalRequests).toBe(1);
  });

  it('consumes the context before awaiting a slow owner claim', async () => {
    respond = (_request, response) => success(response);
    let enterClaim!: () => void;
    let releaseClaim!: () => void;
    const claimEntered = new Promise<void>(resolve => { enterClaim = resolve; });
    const claimGate = new Promise<void>(resolve => { releaseClaim = resolve; });
    const claimModelRequest = jest.fn(async () => { enterClaim(); await claimGate; });
    const owner = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
    });
    restore = registerExecutionExtension(owner);
    const context = mintFixture(owner);
    const first = new OpenAiAdapter().createCompletion(input(context));
    await claimEntered;
    try {
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
      expect(claimModelRequest).toHaveBeenCalledTimes(1);
      expect(physicalRequests).toBe(0);
    } finally {
      releaseClaim();
    }
    await first;
    expect(physicalRequests).toBe(1);
  });

  it('does not send when the owner aborts while its final-fetch claim is pending', async () => {
    const abort = new AbortController();
    let ownerSignal = abort.signal;
    let enterClaim!: () => void;
    let releaseClaim!: () => void;
    const claimEntered = new Promise<void>(resolve => { enterClaim = resolve; });
    const claimGate = new Promise<void>(resolve => { releaseClaim = resolve; });
    const claimModelRequest = jest.fn(async () => { enterClaim(); await claimGate; });
    const owner = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
      signal: () => ownerSignal,
    });
    restore = registerExecutionExtension(owner);
    const context = mintFixture(owner);
    const pending = new OpenAiAdapter().createCompletion(input(context));
    await claimEntered;
    abort.abort();
    releaseClaim();
    // The SDK may surface its own abort error instead of the fetch guard's
    // denial after the combined signal is already aborted.
    await expect(pending).rejects.toThrow();
    ownerSignal = new AbortController().signal;
    await expect(new OpenAiAdapter().createCompletion(input(context)))
      .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
    expect(claimModelRequest).toHaveBeenCalledTimes(1);
    expect(physicalRequests).toBe(0);
  });

  it('rejects a missing or failing owner claim before any POST', async () => {
    for (const claimModelRequest of [undefined, async () => { throw new ExecutionExtensionError('fixture_claim_denied'); }]) {
      const adapter = fixtureAdapter({
        modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
        claimModelRequest,
      });
      restore?.(); restore = registerExecutionExtension(adapter);
      const context = mintFixture(adapter);
      const request = input(context);
      request.onSdkRequest = jest.fn(async () => 'archived-intent');
      request.onSdkRequestResult = jest.fn(async () => undefined);
      await expect(new OpenAiAdapter().createCompletion(request))
        .rejects.toMatchObject({ code: claimModelRequest ? 'fixture_claim_denied' : 'execution_model_request_claim_required' });
      expect(request.onSdkRequest).toHaveBeenCalledTimes(1);
      expect(request.onSdkRequestResult).toHaveBeenCalledWith({ dispatchId: 'archived-intent', outcome: 'error' });
      expect(physicalRequests).toBe(0);
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
    }
    expect(physicalRequests).toBe(0);
  });

  it('hides an untrusted claim error and still consumes the protected context', async () => {
    const adapter = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest: async () => { throw new Error('private credential detail'); },
    });
    restore = registerExecutionExtension(adapter);
    const context = mintFixture(adapter);
    await expect(new OpenAiAdapter().createCompletion(input(context)))
      .rejects.toMatchObject({ code: 'execution_model_request_claim_denied', message: 'execution_model_request_claim_denied' });
    await expect(new OpenAiAdapter().createCompletion(input(context)))
      .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
    expect(physicalRequests).toBe(0);
  });

  it('binds the SDK-final URL, method, credential and body digest and rejects a changed body', async () => {
    let acceptedDigest: string | undefined;
    let postedDigest: string | undefined;
    const claimModelRequest = jest.fn(async (_context: object, intent: ExecutionModelRequestIntent) => {
      if (acceptedDigest && intent.bodySha256 !== acceptedDigest) {
        throw new ExecutionExtensionError('fixture_body_mismatch');
      }
      acceptedDigest = intent.bodySha256;
    });
    const adapter = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
    });
    restore = registerExecutionExtension(adapter);
    respond = (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        postedDigest = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
        success(response);
      })();
    };
    await new OpenAiAdapter().createCompletion(input(mintFixture(adapter)));
    expect(claimModelRequest).toHaveBeenCalledTimes(1);
    expect(claimModelRequest.mock.calls[0][1]).toMatchObject({
      version: 1, operation: 'chat.completions.create',
      model: { id: 'fixture-model', name: 'fixture', provider: 'openai', adapter: 'openai', baseUrl },
      method: 'POST', url: `${baseUrl}/chat/completions`,
      authorizationSha256: createHash('sha256').update('Bearer loopback-fixture-not-a-provider-key').digest('hex'),
      headersSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(acceptedDigest).toBe(postedDigest);
    const changed = input(mintFixture(adapter));
    changed.messages = [{ role: 'user', content: 'changed after original authorization' }];
    await expect(new OpenAiAdapter().createCompletion(changed))
      .rejects.toMatchObject({ code: 'fixture_body_mismatch' });
    expect(physicalRequests).toBe(1);
  });

  it('bypasses an overridden createClient for protected calls while preserving ordinary overrides', async () => {
    const paths: string[] = [];
    respond = (request, response) => { paths.push(request.url ?? ''); success(response); };
    let overridden = 0;
    class ReroutedAdapter extends OpenAiAdapter {
      protected createClient(_model: Model, apiKey: string) {
        overridden += 1;
        return createOpenAIClient({ apiKey, baseURL: `${baseUrl}/unapproved` });
      }
    }
    const { context, claimModelRequest } = run();
    await new ReroutedAdapter().createCompletion(input(context));
    expect(overridden).toBe(0);
    expect(claimModelRequest.mock.calls[0][1].url).toBe(`${baseUrl}/chat/completions`);
    expect(physicalRequests).toBe(1);
    expect(paths).toEqual(['/v1/chat/completions']);
    await new ReroutedAdapter().createCompletion(input());
    expect(overridden).toBe(1);
    expect(physicalRequests).toBe(2);
    expect(paths).toEqual(['/v1/chat/completions', '/v1/unapproved/chat/completions']);
  });

  it('does not inherit OPENAI_BASE_URL for a protected client', async () => {
    respond = (request, response) => {
      expect(request.url).toBe('/v1/chat/completions');
      success(response);
    };
    const prior = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = `${baseUrl}/unapproved`;
    try {
      const { context, claimModelRequest } = run();
      await new OpenAiAdapter().createCompletion(input(context));
      expect(claimModelRequest.mock.calls[0][1].url).toBe(`${baseUrl}/chat/completions`);
      expect(physicalRequests).toBe(1);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prior;
    }
  });

  it('pins an omitted protected base URL to OpenAI rather than an ambient SDK URL', async () => {
    const prior = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = `${baseUrl}/unapproved`;
    let observed: ExecutionModelRequestIntent | undefined;
    const claimModelRequest = jest.fn(async (_context: object, intent: ExecutionModelRequestIntent) => {
      observed = intent;
      throw new ExecutionExtensionError('fixture_stop_before_send');
    });
    const owner = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
    });
    restore = registerExecutionExtension(owner);
    const request = input(mintFixture(owner));
    request.model = { ...request.model, baseUrl: undefined };
    try {
      await expect(new OpenAiAdapter().createCompletion(request))
        .rejects.toMatchObject({ code: 'fixture_stop_before_send' });
      expect(observed?.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(claimModelRequest).toHaveBeenCalledTimes(1);
      expect(physicalRequests).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prior;
    }
  });

  it('rejects a non-loopback HTTP endpoint before claim or dispatch', async () => {
    const { context, claimModelRequest } = run();
    const request = input(context);
    request.model = { ...request.model, baseUrl: 'http://remote.invalid/v1' };
    await expect(new OpenAiAdapter().createCompletion(request))
      .rejects.toMatchObject({ code: 'execution_model_endpoint_invalid' });
    expect(claimModelRequest).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it('rejects SDK custom Authorization headers before claiming or sending', async () => {
    const prior = process.env.OPENAI_CUSTOM_HEADERS;
    process.env.OPENAI_CUSTOM_HEADERS = 'Authorization: Bearer unauthorized-fixture';
    try {
      const { context, claimModelRequest } = run();
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_wire_mismatch' });
      expect(claimModelRequest).not.toHaveBeenCalled();
      expect(physicalRequests).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_CUSTOM_HEADERS;
      else process.env.OPENAI_CUSTOM_HEADERS = prior;
    }
  });

  it('rejects unrecognized protected routing headers before claiming or sending', async () => {
    const prior = process.env.OPENAI_CUSTOM_HEADERS;
    process.env.OPENAI_CUSTOM_HEADERS = 'X-Unapproved-Route: another-account';
    try {
      const { context, claimModelRequest } = run();
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_wire_mismatch' });
      expect(claimModelRequest).not.toHaveBeenCalled();
      expect(physicalRequests).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_CUSTOM_HEADERS;
      else process.env.OPENAI_CUSTOM_HEADERS = prior;
    }
  });

  it('lets the owner reject a changed known account header before any POST', async () => {
    const prior = process.env.OPENAI_CUSTOM_HEADERS;
    process.env.OPENAI_CUSTOM_HEADERS = 'OpenAI-Project: unapproved-fixture';
    const claimModelRequest = jest.fn(async (_context: object, intent: ExecutionModelRequestIntent) => {
      expect(intent.routingHeaderSha256.openaiProject)
        .toBe(createHash('sha256').update('unapproved-fixture').digest('hex'));
      if (intent.routingHeaderSha256.openaiProject !== null) {
        throw new ExecutionExtensionError('fixture_routing_mismatch');
      }
    });
    const owner = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
    });
    restore = registerExecutionExtension(owner);
    try {
      await expect(new OpenAiAdapter().createCompletion(input(mintFixture(owner))))
        .rejects.toMatchObject({ code: 'fixture_routing_mismatch' });
      expect(claimModelRequest).toHaveBeenCalledTimes(1);
      expect(physicalRequests).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_CUSTOM_HEADERS;
      else process.env.OPENAI_CUSTOM_HEADERS = prior;
    }
  });

  it('lets the owner deny a different effective credential before any POST', async () => {
    const expected = createHash('sha256').update('Bearer originally-authorized-fixture').digest('hex');
    const claimModelRequest = jest.fn(async (_context: object, intent: ExecutionModelRequestIntent) => {
      if (intent.authorizationSha256 !== expected) {
        throw new ExecutionExtensionError('fixture_credential_mismatch');
      }
    });
    const owner = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest,
    });
    restore = registerExecutionExtension(owner);
    const request = input(mintFixture(owner));
    request.apiKey = 'different-fixture-key';
    await expect(new OpenAiAdapter().createCompletion(request))
      .rejects.toMatchObject({ code: 'fixture_credential_mismatch' });
    expect(claimModelRequest).toHaveBeenCalledTimes(1);
    expect(physicalRequests).toBe(0);
  });

  it('rejects SDK-final URL and body changes before claim or network dispatch', async () => {
    const { context, claimModelRequest } = run();
    try {
      const originalBuildURL = OpenAI.prototype.buildURL;
      jest.spyOn(OpenAI.prototype, 'buildURL').mockImplementation(function (this: OpenAI, path, query, defaultBaseURL) {
        return originalBuildURL.call(this, path, query, defaultBaseURL).replace('/chat/completions', '/unapproved');
      });
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_wire_mismatch' });
      expect(claimModelRequest).not.toHaveBeenCalled();
      expect(physicalRequests).toBe(0);
      jest.restoreAllMocks();

      const originalBuildRequest = OpenAI.prototype.buildRequest;
      jest.spyOn(OpenAI.prototype, 'buildRequest').mockImplementation(async function (
        this: OpenAI, ...args: Parameters<OpenAI['buildRequest']>
      ) {
        const result = await originalBuildRequest.apply(this, args);
        return { ...result, req: { ...result.req, body: `${result.req.body} ` } };
      });
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_wire_mismatch' });
      expect(claimModelRequest).not.toHaveBeenCalled();
      expect(physicalRequests).toBe(0);
      jest.restoreAllMocks();

      const originalBuildRequestForUnknownBody = OpenAI.prototype.buildRequest;
      jest.spyOn(OpenAI.prototype, 'buildRequest').mockImplementation(async function (
        this: OpenAI, ...args: Parameters<OpenAI['buildRequest']>
      ) {
        const result = await originalBuildRequestForUnknownBody.apply(this, args);
        return { ...result, req: { ...result.req, body: Buffer.from('unapproved body') } };
      });
      await expect(new OpenAiAdapter().createCompletion(input(context)))
        .rejects.toMatchObject({ code: 'execution_model_wire_mismatch' });
      expect(claimModelRequest).not.toHaveBeenCalled();
      expect(physicalRequests).toBe(0);
    } finally {
      jest.restoreAllMocks();
    }
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
    const adapter = fixtureAdapter({ modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }), claimModelRequest: async () => undefined, signal: () => abort.signal });
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

  it.each(['response', 'stream'] as const)('rejects a %s policy downgrade between flow preflight and adapter entry', async mode => {
    respond = (_request, response) => success(response);
    let restricted = true;
    const claimModelRequest = jest.fn(async () => undefined);
    const adapter = fixtureAdapter({
      modelAttemptPolicy: () => restricted ? { version: 1, maxPhysicalAttempts: 1 } : undefined,
      claimModelRequest,
    });
    restore = registerExecutionExtension(adapter);
    const request = input(mintFixture(adapter));
    // ModelHandler observes v1 before asynchronous request preparation.
    expect(await executionExtensionSinglePhysicalAttempt(request.executionExtensionContext, request.model)).toBe(true);
    restricted = false;
    const completionAdapter = getCompletionAdapter(request.model, 'openai');
    await expect(mode === 'stream'
      ? completionAdapter.createStreamCompletion!(request)
      : completionAdapter.createCompletion(request))
      .rejects.toMatchObject({ code: 'execution_model_attempt_policy_changed' });
    expect(claimModelRequest).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it('latches v1 before a pending owner recheck so a concurrent downgrade cannot send', async () => {
    respond = (_request, response) => success(response);
    let enterOwnerCheck!: () => void;
    const ownerCheckEntered = new Promise<void>(resolve => { enterOwnerCheck = () => resolve(); });
    let releaseOwnerCheck!: () => void;
    const ownerCheckGate = new Promise<void>(resolve => { releaseOwnerCheck = () => resolve(); });
    let checks = 0;
    let policies = 0;
    const adapter = fixtureAdapter({
      assertRun: async () => {
        if (++checks === 2) { enterOwnerCheck(); await ownerCheckGate; }
      },
      modelAttemptPolicy: () => ++policies === 1 ? { version: 1, maxPhysicalAttempts: 1 } : undefined,
    });
    restore = registerExecutionExtension(adapter);
    const request = input(mintFixture(adapter));
    const first = executionExtensionSinglePhysicalAttempt(request.executionExtensionContext, request.model);
    await ownerCheckEntered;
    try {
      await expect(new OpenAiAdapter().createCompletion(request))
        .rejects.toMatchObject({ code: 'execution_model_attempt_policy_changed' });
      expect(physicalRequests).toBe(0);
    } finally {
      releaseOwnerCheck();
    }
    expect(await first).toBe(true);
  });

  it('keeps v1 sticky after an unsupported-route rejection', async () => {
    let restricted = true;
    const adapter = fixtureAdapter({
      modelAttemptPolicy: () => restricted ? { version: 1, maxPhysicalAttempts: 1 } : undefined,
    });
    restore = registerExecutionExtension(adapter);
    const request = input(mintFixture(adapter));
    await expect(executionExtensionSinglePhysicalAttempt(request.executionExtensionContext,
      { ...request.model, adapter: 'openai-responses' }))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    restricted = false;
    await expect(new OpenAiAdapter().createCompletion(request))
      .rejects.toMatchObject({ code: 'execution_model_attempt_policy_changed' });
    expect(physicalRequests).toBe(0);
  });

  it('keeps a branded context ordinary when its owner never opts in to the protected policy', async () => {
    respond = (_request, response) => success(response);
    const adapter = fixtureAdapter();
    restore = registerExecutionExtension(adapter);
    const request = input(mintFixture(adapter));
    expect(await executionExtensionSinglePhysicalAttempt(request.executionExtensionContext, request.model)).toBe(false);
    expect((await new OpenAiAdapter().createCompletion(request)).completion.choices[0].message.content).toBe('OK');
    expect(physicalRequests).toBe(1);
  });

  it('gives the owner only model/endpoint identity, excluding provider credentials', async () => {
    const policy = jest.fn((_context: object, _model: ExecutionModelIdentity) => ({ version: 1 as const, maxPhysicalAttempts: 1 as const }));
    const adapter = fixtureAdapter({ modelAttemptPolicy: policy, claimModelRequest: async () => undefined });
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

  it.each([
    ['Requesty with explicit OpenAI adapter', { provider: 'requesty' as const, adapter: 'openai' as const }, OpenAiResponsesAdapter],
    ['OpenRouter with implicit adapter', { provider: 'openrouter' as const, adapter: undefined }, OpenAiResponsesAdapter],
    ['OpenRouter image-only route', { provider: 'openrouter' as const, adapter: 'openai' as const, outputModalities: ['image'] as Model['outputModalities'] }, OpenRouterMediaAdapter],
    ['OpenRouter video-only route', { provider: 'openrouter' as const, adapter: undefined, outputModalities: ['video'] as Model['outputModalities'] }, OpenRouterMediaAdapter],
  ])('rejects protected %s before either concrete native entry sends', async (_name, overrides, expectedAdapter) => {
    const { context, claimModelRequest } = run();
    const routedModel = { ...model(), ...overrides };
    const selected = getCompletionAdapter(routedModel);
    expect(selected).toBeInstanceOf(expectedAdapter);
    await expect(executionExtensionSinglePhysicalAttempt(context, routedModel))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    expect(() => getCompletionAdapter(routedModel, 'openai'))
      .toThrow(expect.objectContaining({ code: 'execution_single_attempt_adapter_unsupported' }));
    const request = { ...input(context), model: routedModel };
    await expect(selected.createCompletion(request))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    await expect(selected.createStreamCompletion!(request))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    expect(claimModelRequest).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it('rejects route drift after policy attestation at the concrete adapter factory', async () => {
    const { context, claimModelRequest } = run();
    const mutableModel = model();
    expect(await executionExtensionSinglePhysicalAttempt(context, mutableModel)).toBe(true);
    mutableModel.provider = 'requesty';
    expect(() => getCompletionAdapter(mutableModel, 'openai'))
      .toThrow(expect.objectContaining({ code: 'execution_single_attempt_adapter_unsupported' }));
    await expect(new OpenAiAdapter().createCompletion({ ...input(context), model: mutableModel }))
      .rejects.toMatchObject({ code: 'execution_single_attempt_adapter_unsupported' });
    expect(claimModelRequest).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it.each(['claim', 'final assert'] as const)('rejects adapter replacement during %s before any POST', async phase => {
    let restoreReplacement: (() => void) | undefined;
    let claimed = false;
    let replaced = false;
    const adapter = fixtureAdapter({
      modelAttemptPolicy: () => ({ version: 1, maxPhysicalAttempts: 1 }),
      claimModelRequest: async () => {
        claimed = true;
        if (phase === 'claim') restoreReplacement = registerExecutionExtension(fixtureAdapter());
      },
      assertRun: async () => {
        if (phase === 'final assert' && claimed && !replaced) {
          replaced = true;
          await Promise.resolve();
          restoreReplacement = registerExecutionExtension(fixtureAdapter());
        }
      },
    });
    restore = registerExecutionExtension(adapter);
    try {
      await expect(new OpenAiAdapter().createCompletion(input(mintFixture(adapter))))
        .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    } finally {
      restoreReplacement?.();
    }
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

  const boundModel = (): Model => ({ ...model(), ownerCredentialBinding: { ownerId: 'owner-fixture', credentialId: 'credential-fixture' } });
  const boundInput = (context: ExecutionExtensionContext, bound = boundModel()): CompletionInput =>
    ({ ...input(context), model: bound, apiKey: '' });

  it.each(['response', 'stream'] as const)('sends a bound %s step only through the owner with no FLUJO credential', async mode => {
    const dispatchModelRequest = jest.fn(async (_step: object, request: ExecutionOwnerModelDispatchRequest) => {
      expect(request.version).toBe(2);
      expect(request.operation).toBe(mode === 'stream' ? 'chat.completions.create(stream)' : 'chat.completions.create');
      expect(request.model.ownerCredentialBinding).toEqual({ ownerId: 'owner-fixture', credentialId: 'credential-fixture' });
      expect(request.url).toBe(`${baseUrl}/chat/completions`);
      expect(request.headers.some(([name]) => name === 'authorization')).toBe(false);
      expect(JSON.stringify(request)).not.toContain('owner-credential-not-present-in-flujo');
      expect(request.bodySha256).toBe(createHash('sha256').update(request.body).digest('hex'));
      expect(request.headersSha256).toBe(createHash('sha256').update(JSON.stringify(request.headers)).digest('hex'));
      const ownerHeaders = new Headers(request.headers.map(([name, value]): [string, string] => [name, value]));
      ownerHeaders.set('authorization', 'Bearer owner-fixture-secret');
      const response = await fetch(request.url, {
        method: request.method,
        headers: ownerHeaders,
        body: Buffer.from(request.body),
        redirect: 'error',
      });
      return response;
    });
    const owner = fixtureAdapter({
      issueModelStep: async parent => ({ ...parent, step: Symbol('fresh-child') }),
      dispatchModelRequest,
    });
    restore = registerExecutionExtension(owner);
    respond = (request, response) => {
      expect(request.headers.authorization).toBe('Bearer owner-fixture-secret');
      if (mode === 'response') return success(response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"id":"fixture-stream","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    const bound = boundModel();
    const parent = mintFixture(owner);
    const child = await issueExecutionModelStepContext(parent, bound);
    const adapter = new OpenAiAdapter();
    const result = mode === 'stream' ? await adapter.createStreamCompletion(boundInput(child, bound)) : await adapter.createCompletion(boundInput(child, bound));
    expect(result.completion.choices[0].message.content).toBe('OK');
    expect(dispatchModelRequest).toHaveBeenCalledTimes(1);
    expect(physicalRequests).toBe(1);
    await expect(adapter.createCompletion(boundInput(child, bound)))
      .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
    expect(dispatchModelRequest).toHaveBeenCalledTimes(1);
    expect(physicalRequests).toBe(1);
  });

  it('requires a fresh bound child, an owner sender and an empty local key before any POST', async () => {
    const bound = boundModel();
    const noIssuer = fixtureAdapter({ dispatchModelRequest: async () => new Response('{}') });
    restore = registerExecutionExtension(noIssuer);
    const parent = mintFixture(noIssuer);
    await expect(issueExecutionModelStepContext(parent, bound))
      .rejects.toMatchObject({ code: 'execution_model_step_issuer_required' });
    await expect(new OpenAiAdapter().createCompletion(boundInput(parent, bound)))
      .rejects.toMatchObject({ code: 'execution_model_step_context_required' });
    restore();

    const owner = fixtureAdapter({ issueModelStep: async value => ({ ...value, step: Symbol('fresh-child') }) });
    restore = registerExecutionExtension(owner);
    const child = await issueExecutionModelStepContext(mintFixture(owner), bound);
    await expect(new OpenAiAdapter().createCompletion(boundInput(child, bound)))
      .rejects.toMatchObject({ code: 'execution_model_dispatch_required' });
    expect(physicalRequests).toBe(0);
    restore();

    const dispatchModelRequest = jest.fn(async () => new Response('{}'));
    const complete = fixtureAdapter({ issueModelStep: async value => ({ ...value, step: Symbol('fresh-child') }), dispatchModelRequest });
    restore = registerExecutionExtension(complete);
    const cleanChild = await issueExecutionModelStepContext(mintFixture(complete), bound);
    await expect(new OpenAiAdapter().createCompletion({ ...boundInput(cleanChild, bound), apiKey: 'local-secret' }))
      .rejects.toMatchObject({ code: 'execution_owner_model_local_credential_forbidden' });
    expect(dispatchModelRequest).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it('does not downgrade an owner-transport context when a saved model loses its binding', async () => {
    const dispatchModelRequest = jest.fn(async () => new Response('{}'));
    const owner = fixtureAdapter({
      issueModelStep: async value => ({ ...value, step: Symbol('fresh-child') }),
      dispatchModelRequest,
    });
    restore = registerExecutionExtension(owner);
    const parent = mintFixture(owner);
    const swapped = { ...model(), id: boundModel().id };
    await expect(new OpenAiAdapter().createCompletion({ ...input(parent), model: swapped }))
      .rejects.toMatchObject({ code: 'execution_owner_model_binding_required' });
    expect(dispatchModelRequest).not.toHaveBeenCalled();
    expect(physicalRequests).toBe(0);
  });

  it('binds each child to its exact model and requires a new owner child for the next step', async () => {
    respond = (_request, response) => success(response);
    const dispatchModelRequest = jest.fn(async (_step: object, request: ExecutionOwnerModelDispatchRequest) => {
      const ownerHeaders = new Headers(request.headers.map(([name, value]): [string, string] => [name, value]));
      ownerHeaders.set('authorization', 'Bearer owner-fixture-secret');
      return fetch(request.url, { method: request.method, headers: ownerHeaders, body: Buffer.from(request.body), redirect: 'error' });
    });
    const owner = fixtureAdapter({ issueModelStep: async value => ({ ...value, step: Symbol('fresh-child') }), dispatchModelRequest });
    restore = registerExecutionExtension(owner);
    const bound = boundModel();
    const parent = mintFixture(owner);
    const first = await issueExecutionModelStepContext(parent, bound);
    await expect(new OpenAiAdapter().createCompletion(boundInput(first, { ...bound, id: 'different-model' })))
      .rejects.toMatchObject({ code: 'execution_model_step_context_required' });
    expect(dispatchModelRequest).not.toHaveBeenCalled();
    await new OpenAiAdapter().createCompletion(boundInput(first, bound));
    const second = await issueExecutionModelStepContext(parent, bound);
    await new OpenAiAdapter().createCompletion(boundInput(second, bound));
    expect(dispatchModelRequest).toHaveBeenCalledTimes(2);
    expect(physicalRequests).toBe(2);
  });

  it('consumes a bound child before awaiting a slow owner sender', async () => {
    respond = (_request, response) => success(response);
    let entered!: () => void;
    let release!: () => void;
    const ownerEntered = new Promise<void>(resolve => { entered = resolve; });
    const ownerGate = new Promise<void>(resolve => { release = resolve; });
    const dispatchModelRequest = jest.fn(async (_step: object, request: ExecutionOwnerModelDispatchRequest) => {
      entered();
      await ownerGate;
      const headers = new Headers(request.headers.map(([name, value]): [string, string] => [name, value]));
      headers.set('authorization', 'Bearer owner-fixture-secret');
      return fetch(request.url, { method: request.method, headers, body: Buffer.from(request.body), redirect: 'error' });
    });
    const owner = fixtureAdapter({ issueModelStep: async value => ({ ...value, step: Symbol('fresh-child') }), dispatchModelRequest });
    restore = registerExecutionExtension(owner);
    const bound = boundModel();
    const child = await issueExecutionModelStepContext(mintFixture(owner), bound);
    const adapter = new OpenAiAdapter();
    const first = adapter.createCompletion(boundInput(child, bound));
    await ownerEntered;
    try {
      await expect(adapter.createCompletion(boundInput(child, bound)))
        .rejects.toMatchObject({ code: 'execution_model_request_already_claimed' });
      expect(dispatchModelRequest).toHaveBeenCalledTimes(1);
      expect(physicalRequests).toBe(0);
    } finally {
      release();
    }
    await first;
    expect(physicalRequests).toBe(1);
  });

  it('does not mint two children when concurrent issuers return one private step object', async () => {
    const baseline = fixtureAdapter();
    const privateRun = fixtureRun();
    const sharedStep = { ...privateRun, step: 'same-owner-value' };
    let entered!: () => void;
    let release!: () => void;
    const childCheckEntered = new Promise<void>(resolve => { entered = resolve; });
    const childCheckGate = new Promise<void>(resolve => { release = resolve; });
    const owner = fixtureAdapter({
      issueModelStep: async () => sharedStep,
      assertRun: async (value, expected) => {
        if (value === sharedStep) { entered(); await childCheckGate; }
        await baseline.assertRun(value, expected);
      },
    });
    restore = registerExecutionExtension(owner);
    const parent = mintFixture(owner, privateRun);
    const first = issueExecutionModelStepContext(parent, boundModel());
    await childCheckEntered;
    try {
      await expect(issueExecutionModelStepContext(parent, boundModel()))
        .rejects.toMatchObject({ code: 'execution_model_step_reused' });
    } finally {
      release();
    }
    await first;
    expect(physicalRequests).toBe(0);
  });

  it('passes only validated v2 fields to the owner sender', async () => {
    let sdkFinal!: ExecutionOwnerModelDispatchRequest;
    const dispatchModelRequest = jest.fn(async (_step: object, request: ExecutionOwnerModelDispatchRequest) => {
      sdkFinal = request;
      return new Response(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', created: 1,
        model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
          message: { role: 'assistant', content: 'OK', refusal: null } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const owner = fixtureAdapter({ issueModelStep: async value => ({ ...value, step: Symbol('fresh-child') }), dispatchModelRequest });
    restore = registerExecutionExtension(owner);
    const bound = boundModel();
    const parent = mintFixture(owner);
    await new OpenAiAdapter().createCompletion(boundInput(await issueExecutionModelStepContext(parent, bound), bound));
    expect(dispatchModelRequest).toHaveBeenCalledTimes(1);

    const child = await issueExecutionModelStepContext(parent, bound);
    await dispatchExecutionModelRequest(child, { ...sdkFinal, extraAuthority: 'forged' } as ExecutionOwnerModelDispatchRequest);
    expect(dispatchModelRequest).toHaveBeenCalledTimes(2);
    expect(dispatchModelRequest.mock.calls[1][1]).not.toHaveProperty('extraAuthority');

    for (const forged of [
      { ...sdkFinal, url: `${baseUrl}/different` },
      { ...sdkFinal, body: Uint8Array.from([1, 2, 3]) },
      { ...sdkFinal, headers: [...sdkFinal.headers, ['authorization', 'Bearer smuggled']] },
    ]) {
      const fresh = await issueExecutionModelStepContext(parent, bound);
      await expect(dispatchExecutionModelRequest(fresh, forged as ExecutionOwnerModelDispatchRequest))
        .rejects.toMatchObject({ code: 'execution_model_wire_mismatch' });
    }
    expect(dispatchModelRequest).toHaveBeenCalledTimes(2);
    expect(physicalRequests).toBe(0);
  });
});
