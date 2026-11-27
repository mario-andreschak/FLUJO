/**
 * Code mode (#1448): the QuickJS sandbox that runs a model's program.
 *
 * These tests run the real worker and the real WebAssembly interpreter. They
 * pin what makes the sandbox safe to offer: the program reaches nothing but
 * the bound tool functions, its time, CPU, memory and call count are bounded,
 * and only its return value and console output come back.
 */
import {
  defaultScriptMemoryBytes,
  runToolScript,
  scriptSlotCount,
  type ScriptCallReply,
} from '@/backend/execution/flow/codeMode/sandbox';
import { buildScriptBindings } from '@/backend/execution/flow/codeMode/codeModeTool';

jest.setTimeout(30_000);

const bindings = buildScriptBindings([
  { name: 'mcp_list_issues_aaaa', server: 'github', tool: 'list_issues' },
  { name: 'mcp_add_label_bbbb', server: 'github', tool: 'add_label' },
  { name: 'mcp_read_file_cccc', server: 'mcp-filesystem', tool: 'read_file' },
]);

const issues = Array.from({ length: 50 }, (_, index) => ({
  number: index + 1,
  title: `Issue ${index + 1}`,
  labels: index % 5 === 0 ? [] : ['bug'],
  body: 'x'.repeat(2_000),
}));

function fakeInvoke(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return async (name: string, args: Record<string, unknown>): Promise<ScriptCallReply> => {
    calls.push({ name, args });
    if (name === 'mcp_list_issues_aaaa') return { ok: true, value: issues };
    if (name === 'mcp_add_label_bbbb') return { ok: true, value: { labelled: args.number } };
    return { ok: false, error: 'file not found' };
  };
}

describe('runToolScript', () => {
  it('calls tools as functions and returns only the program result', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await runToolScript({
      code: [
        'const open = await tools.github.list_issues({ state: "open" });',
        'const unlabelled = open.filter((issue) => issue.labels.length === 0);',
        'const done = await Promise.all(unlabelled.map((issue) => tools.github.add_label({ number: issue.number, label: "triage" })));',
        'console.log("labelled", done.length);',
        'return unlabelled.map((issue) => issue.number);',
      ].join('\n'),
      bindings,
      invoke: fakeInvoke(calls),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual([1, 6, 11, 16, 21, 26, 31, 36, 41, 46]);
    expect(outcome.logs).toBe('labelled 10');
    expect(calls[0]).toEqual({ name: 'mcp_list_issues_aaaa', args: { state: 'open' } });
    expect(calls.filter((call) => call.name === 'mcp_add_label_bbbb')).toHaveLength(10);
    expect(outcome.calls).toHaveLength(11);
    // The 100 KB of issue bodies stayed inside the program.
    expect(JSON.stringify(outcome).length).toBeLessThan(2_000);
  });

  it('maps server names to identifiers and offers callTool by name', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const outcome = await runToolScript({
      code: 'try { await tools.mcp_filesystem.read_file({ path: "a" }); } catch (error) { return "caught: " + error.message; }',
      bindings,
      invoke: fakeInvoke(calls),
    });
    expect(outcome).toMatchObject({ ok: true, result: 'caught: file not found' });

    const byName = await runToolScript({
      code: 'return (await callTool("mcp_add_label_bbbb", { number: 7 })).labelled;',
      bindings,
      invoke: fakeInvoke([]),
    });
    expect(byName).toMatchObject({ ok: true, result: 7 });
  });

  it('gives the program no Node, network, file or timer access', async () => {
    const outcome = await runToolScript({
      code: 'return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof globalThis.Buffer, typeof XMLHttpRequest];',
      bindings,
      invoke: fakeInvoke([]),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('stops a program that keeps the CPU busy', async () => {
    const outcome = await runToolScript({
      code: 'while (true) {}',
      bindings,
      invoke: fakeInvoke([]),
      limits: { busyMs: 300 },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/interrupted/i);
  });

  it('stops a program that uses too much memory', async () => {
    const outcome = await runToolScript({
      code: 'const big = "x".repeat(64 * 1024 * 1024); return big.length;',
      bindings,
      invoke: fakeInvoke([]),
      limits: { memoryBytes: 16 * 1024 * 1024 },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/memory/i);
  });

  it('stops a program that runs past its time limit while waiting on a tool', async () => {
    const outcome = await runToolScript({
      code: 'await tools.github.list_issues({}); return "never";',
      bindings,
      invoke: () => new Promise<ScriptCallReply>(() => undefined),
      limits: { timeoutMs: 400 },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/longer than/);
  });

  it('stops when the run is stopped', async () => {
    const controller = new AbortController();
    const pending = runToolScript({
      code: 'await tools.github.list_issues({}); return "never";',
      bindings,
      invoke: () => {
        controller.abort();
        return new Promise<ScriptCallReply>(() => undefined);
      },
      signal: controller.signal,
    });
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/run stopped/) });
  });

  it('limits the number of tool calls and makes extra parallel calls wait their turn', async () => {
    let running = 0;
    let peak = 0;
    const outcome = await runToolScript({
      code: [
        'const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => tools.github.add_label({ number: i })));',
        'return results.map((r) => r.status);',
      ].join('\n'),
      bindings,
      invoke: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        return { ok: true, value: null };
      },
      limits: { maxCalls: 10, maxParallelCalls: 3 },
    });
    expect(outcome.ok).toBe(true);
    const statuses = outcome.result as string[];
    expect(statuses.filter((status) => status === 'fulfilled')).toHaveLength(10);
    expect(statuses.filter((status) => status === 'rejected')).toHaveLength(2);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports syntax errors and thrown errors as a failed program', async () => {
    await expect(runToolScript({ code: 'return (', bindings, invoke: fakeInvoke([]) }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/SyntaxError/) });
    await expect(runToolScript({ code: 'throw new Error("nope")', bindings, invoke: fakeInvoke([]) }))
      .resolves.toMatchObject({ ok: false, error: 'Error: nope' });
  });

  it('keeps console output within its limit', async () => {
    const outcome = await runToolScript({
      code: 'for (let i = 0; i < 1000; i++) console.log("line " + i); return 1;',
      bindings,
      invoke: fakeInvoke([]),
      limits: { maxLogChars: 200 },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.logs.length).toBeLessThanOrEqual(200);
    expect(outcome.logsTrimmed).toBe(true);
  });
});

describe('sandbox sizing', () => {
  it('scales interpreter memory with the machine within fixed bounds', () => {
    const gb = 1024 ** 3;
    expect(defaultScriptMemoryBytes(2 * gb)).toBe(32 * 1024 * 1024);
    expect(defaultScriptMemoryBytes(16 * gb)).toBe(128 * 1024 * 1024);
    expect(defaultScriptMemoryBytes(256 * gb)).toBe(256 * 1024 * 1024);
  });

  it('runs at least two programs at once and half the cores on bigger machines', () => {
    expect(scriptSlotCount(1)).toBe(2);
    expect(scriptSlotCount(16)).toBe(8);
  });
});
