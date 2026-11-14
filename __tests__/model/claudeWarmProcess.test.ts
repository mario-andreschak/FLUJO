/**
 * Issue #1408: opt-in parked Claude Code processes for the Claude subscription
 * adapter. A parked process must never act for anyone before or after the one
 * request that claims it, must only be claimed by a request with the exact
 * same start-up options, and must fall back to a normal start whenever it
 * cannot serve.
 */
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

import {
  _claudeSpareCountForTests,
  claimClaudeSpare,
  claudeSpareKey,
  closeAllClaudeSpares,
  explainClaudeSpareMiss,
  isClaudeWarmProcessEnabled,
  maxClaudeSpares,
  prepareClaudeSpare,
  releaseClaudeSpare,
  takeClaudeSpare,
  type ClaudeSpareBinding,
} from '@/backend/services/model/adapters/claudeWarmProcess';

type Delegates = Parameters<Parameters<typeof prepareClaudeSpare>[0]['makeOptions']>[0];

function fakeSpareProcess() {
  let resolveClaimed!: (value: { cwd: string; sessionId: string; sdkMcpSettled: boolean }) => void;
  let rejectClaimed!: (error: Error) => void;
  let resolveExited!: () => void;
  const claimed = new Promise<{ cwd: string; sessionId: string; sdkMcpSettled: boolean }>((resolve, reject) => {
    resolveClaimed = resolve; rejectClaimed = reject;
  });
  claimed.catch(() => undefined);
  const exited = new Promise<void>(resolve => { resolveExited = resolve; });
  const process = {
    prompt: undefined as AsyncIterable<SDKUserMessage> | undefined,
    claimOptions: undefined as unknown,
    claim: jest.fn((params: { prompt: AsyncIterable<SDKUserMessage>; options: unknown }) => {
      process.prompt = params.prompt;
      process.claimOptions = params.options;
      return { claimedQuery: true };
    }),
    claimed,
    exited,
    close: jest.fn(() => resolveExited()),
    resolveClaimed,
    rejectClaimed,
    resolveExited,
  };
  return process;
}

const shapeOf = (key: string) => ({ id: key });

function prepare(key: string, process: ReturnType<typeof fakeSpareProcess> | Promise<never>) {
  let delegates!: Delegates;
  const prewarm = jest.fn(async (_params: { options: Options }) => process);
  prepareClaudeSpare({
    shape: shapeOf(key),
    sdk: { prewarm } as never,
    makeOptions: given => { delegates = given; return { model: 'haiku' }; },
  });
  return { prewarm, delegates: () => delegates };
}

const userMessage: SDKUserMessage = {
  type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'where is my order?' },
};
async function* requestPrompt(): AsyncGenerator<SDKUserMessage> { yield userMessage; }

function binding(): ClaudeSpareBinding & { toolSpy: jest.Mock } {
  const toolSpy = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'tool ran for the request' }] }));
  return {
    toolSpy,
    canUseTool: jest.fn(async (_name, input) => ({ behavior: 'allow' as const, updatedInput: input })),
    preToolUse: jest.fn(async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const } })),
    tools: new Map([['lookup', toolSpy]]),
  };
}

async function collect(prompt: AsyncIterable<SDKUserMessage> | undefined): Promise<SDKUserMessage[]> {
  const seen: SDKUserMessage[] = [];
  for await (const message of prompt ?? []) seen.push(message);
  return seen;
}

const permissionContext = () => ({ signal: new AbortController().signal, toolUseID: 'tool-1' }) as never;

afterEach(() => {
  closeAllClaudeSpares();
  jest.useRealTimers();
  delete process.env.FLUJO_CLAUDE_WARM_PROCESS;
  loadItemMock.mockReset();
});

describe('claude warm process key', () => {
  it('is stable across property order and ignores callbacks', () => {
    const a = claudeSpareKey({ model: 'haiku', env: { A: '1', B: '2' }, canUseTool: () => undefined });
    const b = claudeSpareKey({ env: { B: '2', A: '1' }, model: 'haiku' });
    expect(a).toBe(b);
  });

  it('differs for another account, workspace home, instructions or tool set', () => {
    const base = { model: 'haiku', env: { CLAUDE_CODE_OAUTH_TOKEN: 'one', CLAUDE_CONFIG_DIR: '/w1' },
      systemPrompt: 'Classify.', tools: [{ name: 'lookup' }] };
    const key = claudeSpareKey(base);
    expect(claudeSpareKey({ ...base, env: { ...base.env, CLAUDE_CODE_OAUTH_TOKEN: 'two' } })).not.toBe(key);
    expect(claudeSpareKey({ ...base, env: { ...base.env, CLAUDE_CONFIG_DIR: '/w2' } })).not.toBe(key);
    expect(claudeSpareKey({ ...base, systemPrompt: 'Answer.' })).not.toBe(key);
    expect(claudeSpareKey({ ...base, tools: [{ name: 'lookup' }, { name: 'refund' }] })).not.toBe(key);
  });

  it('names the differing parts of a missed shape without their values', () => {
    prepareClaudeSpare({
      shape: { model: 'haiku', env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-one', PATH: '/bin' } },
      sdk: { prewarm: jest.fn(async () => fakeSpareProcess()) } as never,
      makeOptions: () => ({ model: 'haiku' }),
    });
    const missed = { model: 'haiku', env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-two', PATH: '/bin', LATE: '1' } };
    expect(takeClaudeSpare(missed)).toBeUndefined();
    const differing = explainClaudeSpareMiss(missed);
    expect(differing).toEqual(['env.CLAUDE_CODE_OAUTH_TOKEN', 'env.LATE']);
    expect(differing.join()).not.toContain('secret');
  });

  it('does not keep the token readable in the key', () => {
    expect(claudeSpareKey({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-secret' } })).not.toContain('secret');
  });
});

describe('claude warm process switch', () => {
  it('is off unless the setting or the environment turns it on', async () => {
    loadItemMock.mockResolvedValue(undefined);
    await expect(isClaudeWarmProcessEnabled()).resolves.toBe(false);
    loadItemMock.mockResolvedValue({ experimental: { claudeWarmProcess: true } });
    await expect(isClaudeWarmProcessEnabled()).resolves.toBe(true);
    process.env.FLUJO_CLAUDE_WARM_PROCESS = '0';
    await expect(isClaudeWarmProcessEnabled()).resolves.toBe(false);
    process.env.FLUJO_CLAUDE_WARM_PROCESS = '1';
    loadItemMock.mockResolvedValue(undefined);
    await expect(isClaudeWarmProcessEnabled()).resolves.toBe(true);
  });

  it('reads as off when settings cannot be read', async () => {
    loadItemMock.mockRejectedValue(new Error('locked'));
    await expect(isClaudeWarmProcessEnabled()).resolves.toBe(false);
  });

  it('scales the number of parked processes with memory', () => {
    const gib = 1024 ** 3;
    expect(maxClaudeSpares(1 * gib)).toBe(1);
    expect(maxClaudeSpares(4 * gib)).toBe(2);
    expect(maxClaudeSpares(32 * gib)).toBe(4);
  });
});

describe('claude warm process isolation', () => {
  it('denies every callback until a request claims it, and again after release', async () => {
    const spareProcess = fakeSpareProcess();
    const { delegates } = prepare('key-a', spareProcess);
    const d = delegates();

    await expect(d.canUseTool('mcp__flujo__lookup', {}, permissionContext())).resolves.toMatchObject({ behavior: 'deny' });
    await expect(d.preToolUse({ hook_event_name: 'PreToolUse' } as never, 'tool-1', { signal: new AbortController().signal }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await expect(d.toolHandler('lookup')({}, {})).resolves.toMatchObject({ isError: true });

    expect(takeClaudeSpare(shapeOf('key-b'))).toBeUndefined();
    const spare = takeClaudeSpare(shapeOf('key-a'))!;
    expect(spare).toBeDefined();
    expect(takeClaudeSpare(shapeOf('key-a'))).toBeUndefined();

    const bound = binding();
    spareProcess.resolveClaimed({ cwd: '/w', sessionId: 's', sdkMcpSettled: true });
    const query = await claimClaudeSpare(spare, {
      prompt: requestPrompt, cwd: '/w', binding: bound, signal: new AbortController().signal,
    });
    expect(query).toEqual({ claimedQuery: true });
    expect(spareProcess.claimOptions).toEqual({ cwd: '/w' });
    await expect(collect(spareProcess.prompt)).resolves.toEqual([userMessage]);

    await expect(d.canUseTool('mcp__flujo__lookup', { q: 1 }, permissionContext())).resolves.toMatchObject({ behavior: 'allow' });
    await expect(d.toolHandler('lookup')({ q: 1 }, {})).resolves.toMatchObject({ content: [{ text: 'tool ran for the request' }] });
    expect(bound.toolSpy).toHaveBeenCalledWith({ q: 1 }, {});
    await expect(d.toolHandler('refund')({}, {})).resolves.toMatchObject({ isError: true });

    releaseClaudeSpare(spare);
    await expect(d.canUseTool('mcp__flujo__lookup', {}, permissionContext())).resolves.toMatchObject({ behavior: 'deny' });
    await expect(d.toolHandler('lookup')({}, {})).resolves.toMatchObject({ isError: true });
    expect(bound.toolSpy).toHaveBeenCalledTimes(1);
  });

  it('stops the parked process when the claiming request is stopped', async () => {
    const spareProcess = fakeSpareProcess();
    const { delegates } = prepare('key-a', spareProcess);
    spareProcess.resolveClaimed({ cwd: '/w', sessionId: 's', sdkMcpSettled: true });
    const requestStop = new AbortController();
    await claimClaudeSpare(takeClaudeSpare(shapeOf('key-a'))!, {
      prompt: requestPrompt, cwd: '/w', binding: binding(), signal: requestStop.signal,
    });
    expect(delegates().abortController.signal.aborted).toBe(false);
    requestStop.abort();
    expect(delegates().abortController.signal.aborted).toBe(true);
  });
});

describe('claude warm process fallback', () => {
  it('never sends the prompt to a process that refuses the claim', async () => {
    const spareProcess = fakeSpareProcess();
    const { delegates } = prepare('key-a', spareProcess);
    spareProcess.rejectClaimed(new Error('cwd_not_found'));
    const query = await claimClaudeSpare(takeClaudeSpare(shapeOf('key-a'))!, {
      prompt: requestPrompt, cwd: '/w', binding: binding(), signal: new AbortController().signal,
    });
    expect(query).toBeUndefined();
    await expect(collect(spareProcess.prompt)).resolves.toEqual([]);
    await Promise.resolve();
    expect(spareProcess.close).toHaveBeenCalled();
    await expect(delegates().canUseTool('mcp__flujo__lookup', {}, permissionContext())).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('gives up on a process that does not answer in time', async () => {
    jest.useFakeTimers();
    const spareProcess = fakeSpareProcess();
    prepare('key-a', spareProcess);
    const pending = claimClaudeSpare(takeClaudeSpare(shapeOf('key-a'))!, {
      prompt: requestPrompt, cwd: '/w', binding: binding(), signal: new AbortController().signal,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
    await expect(collect(spareProcess.prompt)).resolves.toEqual([]);
  });

  it('gives up on a process that never finishes starting', async () => {
    jest.useFakeTimers();
    prepare('key-a', new Promise<never>(() => undefined));
    const pending = claimClaudeSpare(takeClaudeSpare(shapeOf('key-a'))!, {
      prompt: requestPrompt, cwd: '/w', binding: binding(), signal: new AbortController().signal,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it('stops waiting for a parked process when the request is stopped', async () => {
    const spareProcess = fakeSpareProcess();
    prepare('key-a', spareProcess);
    const requestStop = new AbortController();
    const pending = claimClaudeSpare(takeClaudeSpare(shapeOf('key-a'))!, {
      prompt: requestPrompt, cwd: '/w', binding: binding(), signal: requestStop.signal,
    });
    await new Promise(resolve => setImmediate(resolve));
    requestStop.abort();
    await expect(pending).resolves.toBeUndefined();
    await expect(collect(spareProcess.prompt)).resolves.toEqual([]);
  });

  it('drops a process that failed to start or died while parked', async () => {
    prepare('key-a', Promise.reject(new Error('spawn failed')) as Promise<never>);
    const parked = fakeSpareProcess();
    prepare('key-b', parked);
    await new Promise(resolve => setImmediate(resolve));
    expect(takeClaudeSpare(shapeOf('key-a'))).toBeUndefined();
    parked.resolveExited();
    await new Promise(resolve => setImmediate(resolve));
    expect(takeClaudeSpare(shapeOf('key-b'))).toBeUndefined();
    expect(_claudeSpareCountForTests()).toBe(0);
  });

  it('survives an SDK that throws instead of rejecting', async () => {
    expect(() => prepareClaudeSpare({
      shape: shapeOf('key-a'),
      sdk: { prewarm: () => { throw new Error('bad options'); } } as never,
      makeOptions: () => ({ model: 'haiku' }),
    })).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(_claudeSpareCountForTests()).toBe(0);
  });

  it('closes a process nobody claimed within ten minutes', async () => {
    jest.useFakeTimers();
    const spareProcess = fakeSpareProcess();
    prepare('key-a', spareProcess);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(_claudeSpareCountForTests()).toBe(0);
    expect(spareProcess.close).toHaveBeenCalled();
  });

  it('keeps one process per request shape and evicts the oldest past the memory bound', async () => {
    const limit = maxClaudeSpares();
    const processes = Array.from({ length: limit + 1 }, () => fakeSpareProcess());
    const first = prepare('key-0', processes[0]);
    const duplicate = prepare('key-0', fakeSpareProcess());
    await new Promise(resolve => setImmediate(resolve));
    expect(first.prewarm).toHaveBeenCalledTimes(1);
    expect(duplicate.prewarm).not.toHaveBeenCalled();
    expect(_claudeSpareCountForTests()).toBe(1);
    for (let index = 1; index <= limit; index++) prepare(`key-${index}`, processes[index]);
    expect(_claudeSpareCountForTests()).toBe(limit);
    await new Promise(resolve => setImmediate(resolve));
    expect(processes[0].close).toHaveBeenCalled();
    expect(takeClaudeSpare(shapeOf('key-0'))).toBeUndefined();
  });

  it('closes every parked process when switched off', async () => {
    const one = fakeSpareProcess();
    const two = fakeSpareProcess();
    prepare('key-a', one);
    prepare('key-b', two);
    closeAllClaudeSpares();
    await new Promise(resolve => setImmediate(resolve));
    expect(_claudeSpareCountForTests()).toBe(0);
    expect(one.close).toHaveBeenCalled();
    expect(two.close).toHaveBeenCalled();
  });
});
