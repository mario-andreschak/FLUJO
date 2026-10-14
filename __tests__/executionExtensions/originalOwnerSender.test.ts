import { fetch as physicalFetch } from 'undici';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Stream } from 'openai/core/streaming';
import type { ExecutionBoundModelIdentity, ExecutionOwnerModelDispatchRequest } from '@/backend/execution/extensions';
import type { Model } from '@/shared/types/model';
import type { OriginalOwnerAuthority, OriginalOwnerBinding } from '@/backend/services/originalOwner/authority';
import { assertOriginalOwnerAuthority } from '@/backend/services/originalOwner/authority';
import { assertOriginalApproval } from '@/backend/services/originalOwner/administration';
import { modelService } from '@/backend/services/model';
import { decryptWithPassword } from '@/utils/encryption/secure';
import { mutateOriginalOwnerBook, readOriginalOwnerBook, flushOriginalOwnerBook } from '@/backend/services/originalOwner/store';
import {
  dispatchOriginalOwnerModelRequest, issueOriginalOwnerModelStep, originalOwnerModelStepRouting,
} from '@/backend/services/originalOwner/sender';
import {
  accountModelPlan, BookSchema, bytesDigest, ownerDigest, OriginalOwnerError, type OriginalOwnerBook,
} from '@/backend/services/originalOwner/types';

// These are sender regressions against a mocked membership/fence/store contract.
// They do not qualify real Persona authority, owner enrollment, or paid inference.
jest.mock('undici', () => ({ fetch: jest.fn(), Agent: jest.fn() }));
jest.mock('@/backend/execution/extensions/configuredAdapter', () => ({ configuredExecutionAdapter: undefined }));
jest.mock('@/backend/services/model/openaiClient', () => ({ PROTECTED_OPENAI_DEFAULT_BASE_URL: 'https://api.openai.com/v1' }));
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: jest.fn() } }));
jest.mock('@/utils/encryption/secure', () => ({ decryptWithPassword: jest.fn() }));
jest.mock('@/backend/services/originalOwner/administration', () => ({ assertOriginalApproval: jest.fn() }));
jest.mock('@/backend/services/originalOwner/authority', () => ({ assertOriginalOwnerAuthority: jest.fn() }));
jest.mock('@/backend/services/originalOwner/store', () => ({
  mutateOriginalOwnerBook: jest.fn(), readOriginalOwnerBook: jest.fn(), flushOriginalOwnerBook: jest.fn(),
}));

const mockedFetch = jest.mocked(physicalFetch);
const mockedMutate = jest.mocked(mutateOriginalOwnerBook);
const mockedRead = jest.mocked(readOriginalOwnerBook);
const mockedFlush = jest.mocked(flushOriginalOwnerBook);
const mockedModel = jest.mocked(modelService.getModel);
const mockedDecrypt = jest.mocked(decryptWithPassword);
const mockedAuthority = jest.mocked(assertOriginalOwnerAuthority);
const mockedApproval = jest.mocked(assertOriginalApproval);
const fixtureCredential = 'sender-regression-private-key';
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const bytes = (value: string) => new TextEncoder().encode(value);

describe('original owner sender contract regressions (authority/store fixtures)', () => {
  let book: OriginalOwnerBook;
  let model: Model;
  let genuine: WeakSet<object>;
  let personaHeld: boolean;
  let bookHeld: boolean;
  let journalQueue: Promise<void>;
  let personaQueue: Promise<void>;
  let personaScope: AsyncLocalStorage<boolean>;
  let durable: OriginalOwnerBook[];
  let controls: AbortController[];

  function bound(): ExecutionBoundModelIdentity {
    return { id: model.id, name: model.name, adapter: model.adapter, provider: model.provider,
      baseUrl: model.baseUrl, ownerCredentialBinding: { ...model.ownerCredentialBinding! } };
  }
  function authority(overrides: Partial<OriginalOwnerBinding> = {}) {
    const control = new AbortController(); controls.push(control);
    const state = { live: true, fenceChecks: 0 };
    const binding: OriginalOwnerBinding = Object.freeze({
      workspace: 'regression-workspace', ownerId: 'regression-owner', enrollmentId: 'regression-enrollment',
      accountId: 'regression-account', modelId: model.id, modelDigest: ownerDigest(accountModelPlan(model)),
      originalRunId: 'regression-original-run', leaseId: 'regression-lease', leaseEpoch: ownerDigest('epoch'),
      personaId: 'regression-persona', taskId: 'regression-task', goalId: 'regression-goal', round: 0,
      activityId: 'regression-activity', dispatchId: 'regression-dispatch', revisionId: 'regression-revision',
      conversationId: 'regression-conversation', runId: 'regression-run', flowId: 'regression-flow',
      planDigest: ownerDigest('plan'), enrollmentDigest: ownerDigest(book.enrollments[0]), accountDigest: ownerDigest(book.accounts[0]),
      ...overrides,
    });
    const value: OriginalOwnerAuthority = Object.freeze({
      binding, signal: control.signal,
      assertCurrent: jest.fn(async () => {
        // The production Original capability has a private, active-fence path
        // which refreshes persisted joins without recursive Persona locking.
        if (personaScope.getStore()) state.fenceChecks += 1;
        if (!state.live) throw new OriginalOwnerError('regression_lease_expired');
        if (control.signal.aborted) throw new OriginalOwnerError('regression_authority_revoked');
      }),
      assertRunPlan: jest.fn(async () => {}),
      assertModelPlan: jest.fn(async plan => {
        await value.assertCurrent();
        if (plan.nodeId !== 'process' || plan.modelId !== binding.modelId) throw new OriginalOwnerError('regression_model_plan_changed');
      }),
      commitWhileCurrent: async <T>(task: (current: OriginalOwnerBinding) => Promise<T>) => {
        const previous = personaQueue;
        let release!: () => void;
        personaQueue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
          if (control.signal.aborted) throw new OriginalOwnerError('regression_authority_revoked');
          return await personaScope.run(true, async () => {
            personaHeld = true;
            const result = await task(binding);
            if (control.signal.aborted) throw new OriginalOwnerError('regression_authority_revoked');
            return result;
          });
        } finally { personaHeld = false; release(); }
      },
    });
    genuine.add(value);
    return { value, control, state };
  }
  const issue = (owner: OriginalOwnerAuthority, ordinal = 0) => issueOriginalOwnerModelStep(owner, bound(), { nodeId: 'process', ordinal });
  function request(input: { stream?: boolean; cap?: number | null; n?: number; headers?: [string, string][]; signal?: AbortSignal } = {}): ExecutionOwnerModelDispatchRequest {
    const body = bytes(JSON.stringify({ model: model.name, messages: [{ role: 'user', content: 'sender fixture' }],
      ...(input.cap === null ? {} : { max_tokens: input.cap ?? 40 }),
      ...(input.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(input.n === undefined ? {} : { n: input.n }),
    }));
    const headers: [string, string][] = input.headers ?? [['content-type', 'application/json']];
    const hash = (name: string) => {
      const value = headers.find(([key]) => key === name)?.[1]; return value === undefined ? null : bytesDigest(value);
    };
    return { version: 2, operation: input.stream ? 'chat.completions.create(stream)' : 'chat.completions.create',
      model: bound(), method: 'POST', url: `${model.baseUrl}/chat/completions`, body, headers,
      bodySha256: bytesDigest(body), headersSha256: bytesDigest(JSON.stringify(headers)),
      routingHeaderSha256: { openaiOrganization: hash('openai-organization'), openaiProject: hash('openai-project'),
        httpReferer: hash('http-referer'), xTitle: hash('x-title') }, signal: input.signal };
  }
  function completion(usage: unknown = { prompt_tokens: 7, completion_tokens: 9 }) {
    return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      ...(usage === null ? {} : { usage }) }), { headers: { 'content-type': 'application/json' } });
  }
  function respond(response: Response) {
    mockedFetch.mockImplementationOnce(async (_url, options) => {
      expect(personaHeld).toBe(true); expect(bookHeld).toBe(true);
      expect(durable.at(-1)?.steps.at(-1)).toMatchObject({ state: 'sending', bodyDigest: expect.any(String), headersDigest: expect.any(String) });
      expect(options?.redirect).toBe('manual');
      expect(new Headers(options?.headers as HeadersInit).get('authorization')).toBe(`Bearer ${fixtureCredential}`);
      return response as never;
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.clearAllMocks();
    genuine = new WeakSet(); controls = []; durable = [];
    personaHeld = false; bookHeld = false; journalQueue = Promise.resolve(); personaQueue = Promise.resolve();
    personaScope = new AsyncLocalStorage<boolean>();
    model = { id: 'regression-model', name: 'regression-model-name', adapter: 'openai', provider: 'openai',
      ApiKey: '', baseUrl: 'https://owner-sender.invalid/v1',
      ownerCredentialBinding: { ownerId: 'regression-owner', credentialId: 'regression-account' } };
    const approval = { ownerId: 'regression-owner', credentialId: 'regression-administrator', policyRevision: ownerDigest('policy') };
    book = { version: 1, accounts: [{ id: 'regression-account', ownerId: 'regression-owner', modelId: model.id,
      kind: 'openai', modelDigest: ownerDigest(accountModelPlan(model)), credential: 'encrypted:regression-envelope', routingHeaders: {},
      state: 'active', approval, createdAt: 1, updatedAt: 1 }],
    enrollments: [{ id: 'regression-enrollment', workspace: 'regression-workspace', ownerId: 'regression-owner',
      personaId: 'regression-persona', taskId: 'regression-task', accountId: 'regression-account', modelId: model.id,
      workerAuthorizationDigest: ownerDigest('worker-authorization'), budget: { maxModelSteps: null, maxOutputTokens: null },
      allowedTools: [], commands: [], state: 'active', approval, createdAt: 1, updatedAt: 1 }], steps: [] };
    mockedAuthority.mockImplementation(value => {
      if (!value || typeof value !== 'object' || !genuine.has(value)) throw new OriginalOwnerError('original_owner_runtime_authority_required');
    });
    mockedApproval.mockImplementation(() => {});
    mockedModel.mockImplementation(async () => model);
    mockedDecrypt.mockResolvedValue(fixtureCredential);
    mockedRead.mockImplementation(async () => book);
    mockedFlush.mockImplementation(async () => { BookSchema.parse(book); durable.push(JSON.parse(JSON.stringify(book))); });
    mockedMutate.mockImplementation(async task => {
      const previous = journalQueue;
      let release!: () => void;
      journalQueue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { bookHeld = true; const result = await task(book); await mockedFlush(); return result; }
      finally { bookHeld = false; release(); }
    });
    mockedFetch.mockReset();
  });
  afterEach(async () => {
    controls.forEach(value => value.abort());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jest.getTimerCount()).toBe(0);
    expect((globalThis as { __flujoOriginalOwnerActiveSends?: Map<string, string> }).__flujoOriginalOwnerActiveSends?.size ?? 0).toBe(0);
    jest.useRealTimers();
  });

  it('rejects serialized/structural authority before touching the journal or transport', async () => {
    const { value } = authority();
    await expect(issue({ ...value })).rejects.toMatchObject({ code: 'original_owner_runtime_authority_required' });
    expect(mockedMutate).not.toHaveBeenCalled(); expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('accepts ordinal zero and reuses the durable slot across a changed lease', async () => {
    await issue(authority().value);
    const id = book.steps[0].id;
    await issue(authority({ leaseId: 'replacement-lease', leaseEpoch: ownerDigest('replacement-epoch') }).value);
    expect(book.steps).toHaveLength(1);
    expect(book.steps[0]).toMatchObject({ id, ordinal: 0, nodeId: 'process', state: 'issued', leaseId: 'replacement-lease' });
  });
  it('publishes detached approved routing, with no credential material', async () => {
    book.accounts[0].routingHeaders = { 'openai-project': 'approved-project' };
    const step = await issue(authority().value);
    const result = await originalOwnerModelStepRouting(step);
    expect(Object.isFrozen(result)).toBe(true); expect(result).toEqual({ 'openai-project': 'approved-project' });
    expect(JSON.stringify(result)).not.toContain(fixtureCredential);
    book.accounts[0].routingHeaders['openai-project'] = 'changed-project';
    expect(result['openai-project']).toBe('approved-project');
  });
  it('fsyncs the exact final wire before its only physical send, and finishes outside both locks', async () => {
    const owner = authority().value, input = request();
    const step = await issue(owner);
    respond(completion());
    const response = await dispatchOriginalOwnerModelRequest(step, input);
    expect(personaHeld).toBe(false); expect(bookHeld).toBe(false);
    await response.json();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(book.steps[0]).toMatchObject({ state: 'completed', status: 200, usage: { inputTokens: 7, outputTokens: 9 },
      bodyDigest: input.bodySha256, headersDigest: input.headersSha256, urlDigest: bytesDigest(input.url),
      routingDigest: ownerDigest(input.routingHeaderSha256), maxOutputTokens: 40 });
    expect(JSON.stringify(book)).not.toContain(fixtureCredential);
    expect(mockedDecrypt).toHaveBeenCalledWith('regression-envelope');
    await expect(dispatchOriginalOwnerModelRequest(step, input)).rejects.toMatchObject({ code: 'original_owner_model_step_spent' });
    await expect(issue(owner)).rejects.toMatchObject({ code: 'original_owner_model_step_spent' });
  });
  it('CAS permits only one send from independently issued capabilities for the same durable slot', async () => {
    const owner = authority().value, first = await issue(owner), second = await issue(owner);
    respond(completion());
    const results = await Promise.allSettled([
      dispatchOriginalOwnerModelRequest(first, request()), dispatchOriginalOwnerModelRequest(second, request()),
    ]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    for (const value of results) if (value.status === 'fulfilled') await value.value.json();
    expect(mockedFetch).toHaveBeenCalledTimes(1); expect(book.steps[0].state).toBe('completed');
  });
  it.each([
    ['URL', (input: ExecutionOwnerModelDispatchRequest) => { input.url = 'https://other.invalid/v1/chat/completions'; }],
    ['body digest', (input: ExecutionOwnerModelDispatchRequest) => { input.body[0] = 33; }],
    ['header digest', (input: ExecutionOwnerModelDispatchRequest) => { input.headersSha256 = ownerDigest('wrong'); }],
    ['Authorization', (input: ExecutionOwnerModelDispatchRequest) => {
      input.headers = [['authorization', 'Bearer caller-controlled'], ...input.headers];
      input.headersSha256 = bytesDigest(JSON.stringify(input.headers));
    }],
    ['routing digest', (input: ExecutionOwnerModelDispatchRequest) => { input.routingHeaderSha256.openaiProject = ownerDigest('wrong'); }],
  ] as const)('rejects a changed %s and durably consumes the issued child', async (_name, change) => {
    const step = await issue(authority().value), input = request(); change(input);
    await expect(dispatchOriginalOwnerModelRequest(step, input)).rejects.toMatchObject({ code: 'original_owner_wire_mismatch' });
    expect(book.steps[0].state).toBe('rejected'); expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('compares approved routing and actual saved owner/model binding again at send', async () => {
    const step = await issue(authority().value), input = request();
    model.ownerCredentialBinding = { ownerId: 'other-owner', credentialId: 'regression-account' };
    await expect(dispatchOriginalOwnerModelRequest(step, input)).rejects.toMatchObject({ code: 'original_owner_model_changed' });
    expect(mockedFetch).not.toHaveBeenCalled(); expect(book.steps[0].state).toBe('rejected');
  });
  it('rejects a wire routing value that was never approved on the account', async () => {
    const step = await issue(authority().value);
    await expect(dispatchOriginalOwnerModelRequest(step, request({ headers: [
      ['content-type', 'application/json'], ['openai-project', 'unapproved-project'],
    ] }))).rejects.toMatchObject({ code: 'original_owner_routing_changed' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('enforces explicit step limits while null grants have no inferred default', async () => {
    book.enrollments[0].budget.maxModelSteps = 1;
    const owner = authority().value;
    await issue(owner);
    await expect(issue(owner, 1)).rejects.toMatchObject({ code: 'original_owner_model_budget_exhausted' });
    book.enrollments[0].budget.maxModelSteps = null;
    await expect(issue(owner, 1)).resolves.toBeDefined();
  });
  it('reserves cumulative output and releases only actual known completed usage', async () => {
    book.enrollments[0].budget.maxOutputTokens = 100;
    const owner = authority().value;
    const first = await issue(owner); respond(completion({ prompt_tokens: 10, completion_tokens: 20 }));
    await (await dispatchOriginalOwnerModelRequest(first, request({ cap: 70 }))).json();
    const second = await issue(owner, 1); respond(completion({ prompt_tokens: 11, completion_tokens: 20 }));
    await (await dispatchOriginalOwnerModelRequest(second, request({ cap: 80 }))).json();
    const third = await issue(owner, 2);
    await expect(dispatchOriginalOwnerModelRequest(third, request({ cap: 90 }))).rejects.toMatchObject({ code: 'original_owner_output_budget_exhausted' });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
  it('keeps absent counters null and retains their output reservation', async () => {
    book.enrollments[0].budget.maxOutputTokens = 100;
    const owner = authority().value, first = await issue(owner); respond(completion(null));
    await (await dispatchOriginalOwnerModelRequest(first, request({ cap: 70 }))).json();
    expect(book.steps[0].usage).toEqual({ inputTokens: null, outputTokens: null });
    const second = await issue(owner, 1);
    await expect(dispatchOriginalOwnerModelRequest(second, request({ cap: 40 }))).rejects.toMatchObject({ code: 'original_owner_output_budget_exhausted' });
  });
  it('requires an explicit output cap for a finite grant and honors saved model cap', async () => {
    book.enrollments[0].budget.maxOutputTokens = 100;
    const owner = authority().value;
    await expect(dispatchOriginalOwnerModelRequest(await issue(owner), request({ cap: null }))).rejects.toMatchObject({ code: 'original_owner_output_budget_exhausted' });
    model.maxTokens = 50; book.accounts[0].modelDigest = ownerDigest(accountModelPlan(model));
    const changed = authority().value;
    await expect(dispatchOriginalOwnerModelRequest(await issue(changed, 1), request({ cap: 40 }))).rejects.toMatchObject({ code: 'original_owner_output_limit_changed' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('permits omitted output caps only under an explicit unlimited owner grant', async () => {
    const step = await issue(authority().value); respond(completion());
    await (await dispatchOriginalOwnerModelRequest(step, request({ cap: null }))).json();
    expect(book.steps[0]).toMatchObject({ state: 'completed', maxOutputTokens: null });
  });
  it('turns an unobserved durable sending into unknown and blocks a different run/slot', async () => {
    await issue(authority().value);
    book.steps[0].state = 'sending'; book.steps[0].senderId = 'dead-process-regression-sender';
    await expect(issue(authority({ originalRunId: 'new-original-run' }).value, 9)).rejects.toMatchObject({ code: 'original_owner_model_outcome_unknown' });
    expect(durable.at(-1)?.steps[0].state).toBe('unknown'); expect(mockedFetch).not.toHaveBeenCalled();
  });
  it.each([302, 408, 503])('records ambiguous HTTP %i as unknown, suppresses redirects/retries and redacts provider text/headers', async status => {
    const owner = authority().value, step = await issue(owner);
    respond(new Response(fixtureCredential, { status, headers: { location: 'https://another.invalid', authorization: fixtureCredential,
      'x-request-id': fixtureCredential, 'set-cookie': fixtureCredential } }));
    const response = await dispatchOriginalOwnerModelRequest(step, request());
    expect(await response.text()).not.toContain(fixtureCredential); expect([...response.headers.keys()]).toEqual(['content-type']);
    expect(book.steps[0]).toMatchObject({ state: 'unknown', status });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    await expect(issue(owner, 1)).rejects.toMatchObject({ code: 'original_owner_model_outcome_unknown' });
  });
  it('redacts a provider error hidden inside an HTTP 200 JSON body', async () => {
    const step = await issue(authority().value);
    respond(new Response(JSON.stringify({ error: { message: fixtureCredential } })));
    const response = await dispatchOriginalOwnerModelRequest(step, request());
    await expect(response.text()).rejects.toMatchObject({ code: 'original_owner_provider_rejected' });
    expect(book.steps[0].state).toBe('rejected');
  });
  it.each(['data', 'event'] as const)('redacts a split SSE %s error before the installed SDK can archive it', async kind => {
    const step = await issue(authority().value);
    const error = kind === 'event' ? `event: error\ndata: ${JSON.stringify({ message: fixtureCredential })}\n\n`
      : data({ error: { message: fixtureCredential } });
    const stream = new ReadableStream<Uint8Array>({ start(output) {
      output.enqueue(bytes(error.slice(0, 10))); output.enqueue(bytes(error.slice(10))); output.close();
    } });
    respond(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await dispatchOriginalOwnerModelRequest(step, request({ stream: true }));
    let failure: unknown;
    try { for await (const item of Stream.fromSSEResponse(response, new AbortController())) void item; }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'original_owner_provider_rejected' });
    expect(String(failure)).not.toContain(fixtureCredential); expect(book.steps[0].state).toBe('rejected');
  });
  it('records completed at a validated DONE sentinel while the provider socket remains open', async () => {
    const owner = authority().value, step = await issue(owner), cancel = jest.fn();
    const chunk = { choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'OK' } }], usage: { prompt_tokens: 7, completion_tokens: 9 } };
    const stream = new ReadableStream<Uint8Array>({ start(output) { output.enqueue(bytes(`${data(chunk)}data: [DONE]\n\n`)); }, cancel });
    respond(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await dispatchOriginalOwnerModelRequest(step, request({ stream: true }));
    const received: unknown[] = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) received.push(item);
    expect(received).toEqual([chunk]); expect(cancel).toHaveBeenCalledTimes(1);
    expect(book.steps[0]).toMatchObject({ state: 'completed', usage: { inputTokens: 7, outputTokens: 9 } });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('retains partial stream usage as unknown after a disconnect and refuses a replacement child', async () => {
    const owner = authority().value, step = await issue(owner);
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    respond(new Response(new ReadableStream<Uint8Array>({ start(output) {
      upstream = output;
      output.enqueue(bytes(data({ choices: [{ index: 0, finish_reason: null, delta: { content: 'partial' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 } })));
    } })));
    const response = await dispatchOriginalOwnerModelRequest(step, request({ stream: true }));
    const reader = response.body!.getReader();
    await reader.read(); upstream.error(new Error(fixtureCredential));
    await expect(reader.read()).rejects.toMatchObject({ code: 'original_owner_model_outcome_unknown' });
    expect(book.steps[0]).toMatchObject({ state: 'unknown', usage: { inputTokens: 7, outputTokens: 3 } });
    await expect(issue(owner, 1)).rejects.toMatchObject({ code: 'original_owner_model_outcome_unknown' });
  });
  it('aborts before the socket for an already cancelled caller', async () => {
    const step = await issue(authority().value), control = new AbortController(); control.abort();
    await expect(dispatchOriginalOwnerModelRequest(step, request({ signal: control.signal }))).rejects.toMatchObject({ code: 'original_owner_model_aborted' });
    expect(book.steps[0].state).toBe('aborted'); expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('releases the output reservation when cancellation arrives during the pre-send durability barrier', async () => {
    const step = await issue(authority().value), control = new AbortController();
    const flush = mockedFlush.getMockImplementation()!;
    mockedFlush.mockImplementation(async () => {
      await flush();
      if (book.steps[0].state === 'sending') control.abort();
    });
    await expect(dispatchOriginalOwnerModelRequest(step, request({ signal: control.signal }))).rejects.toMatchObject({ code: 'original_owner_model_aborted' });
    expect(book.steps[0]).toMatchObject({ state: 'aborted', senderId: undefined }); expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('rechecks persisted lease expiry inside the active fence after fsync and refuses the socket', async () => {
    const owner = authority(), step = await issue(owner.value);
    const flush = mockedFlush.getMockImplementation()!;
    mockedFlush.mockImplementation(async () => {
      await flush();
      if (book.steps[0].state === 'sending') owner.state.live = false;
    });
    await expect(dispatchOriginalOwnerModelRequest(step, request())).rejects.toMatchObject({ code: 'regression_lease_expired' });
    expect(owner.state.fenceChecks).toBe(1);
    expect(book.steps[0]).toMatchObject({ state: 'rejected', senderId: undefined });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
  it('durably aborts revoked authority while waiting for provider headers and cleans its observer', async () => {
    const owner = authority(), step = await issue(owner.value);
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let signal: AbortSignal | undefined;
    mockedFetch.mockImplementationOnce((_url, options) => { signal = options?.signal ?? undefined; enter(); return new Promise(() => {}); });
    const pending = dispatchOriginalOwnerModelRequest(step, request());
    await entered;
    await new Promise<void>(resolve => setImmediate(resolve));
    owner.control.abort();
    await expect(pending).rejects.toMatchObject({ code: 'original_owner_model_outcome_unknown' });
    expect(signal?.aborted).toBe(true); expect(book.steps[0].state).toBe('unknown'); expect(jest.getTimerCount()).toBe(0);
  });
  it('observes persisted account revocation while waiting for a stream read', async () => {
    const step = await issue(authority().value), cancelled = jest.fn();
    respond(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
    const response = await dispatchOriginalOwnerModelRequest(step, request({ stream: true }));
    const read = response.body!.getReader().read();
    const rejected = expect(read).rejects.toMatchObject({ code: 'original_owner_model_outcome_unknown' });
    book.accounts[0].state = 'revoked';
    await jest.advanceTimersByTimeAsync(250);
    await rejected;
    expect(cancelled).toHaveBeenCalledTimes(1); expect(book.steps[0].state).toBe('unknown'); expect(jest.getTimerCount()).toBe(0);
  });
});
