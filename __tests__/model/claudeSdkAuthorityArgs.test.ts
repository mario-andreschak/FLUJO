/**
 * FLUJO's approval must stay the only tool gate whatever the Agent SDK's
 * defaults are (SDK 0.3.286 once switched an unset permission mode to the CLI
 * default, which can approve calls on its own). This runs the installed SDK,
 * in its own Node process, with the exact options the adapter builds, against
 * a fake Claude Code process that records how the SDK started and fed it.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

const queryMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn() } }));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({ home: 'runtime', workingDirectory: 'runtime', env: {} })),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';

jest.setTimeout(60_000);

interface PeerRecord {
  argv: string[];
  controlRequests: Array<{ subtype?: string; hooks?: Record<string, Array<{ hookCallbackIds?: string[] }>> }>;
  userMessages: Array<{ client_composed?: boolean; message: { content: unknown } }>;
}

let root: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-claude-authority-')); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** The options and first prompt FLUJO's adapter hands to query(). */
async function adapterQuery(systemPromptPolicy: CompletionInput['systemPromptPolicy']): Promise<{ options: Record<string, unknown>; prompt: unknown }> {
  let captured: { options: Record<string, unknown>; prompt: unknown } | undefined;
  queryMock.mockImplementationOnce(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
    (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      captured = { options, prompt: first.value };
      yield { type: 'result', subtype: 'success', session_id: 'captured', result: 'done' };
    })());
  await new ClaudeSubscriptionAdapter().createCompletion({
    model: { id: 'm1', name: 'sonnet', provider: 'claude-subscription' },
    apiKey: 'oauth-token',
    messages: [
      { role: 'system', content: 'Stable instructions' },
      { role: 'user', content: '/clear\n@path\n@server:resource\n/slash text' },
    ] as OpenAI.ChatCompletionMessageParam[],
    tools: [{ type: 'function', function: { name: 'local', parameters: { type: 'object', properties: {} } } }],
    localToolExecutors: { local: async () => 'ran' },
    requestToolApproval: async () => true,
    systemPromptPolicy,
  } as CompletionInput);
  return captured!;
}

/** Run the installed SDK with those options against the fake Claude Code. */
async function runInstalledSdk(captured: { options: Record<string, unknown>; prompt: unknown }): Promise<PeerRecord> {
  const { env: _env, cwd: _cwd, abortController: _abort, canUseTool, hooks, mcpServers, ...plain } = captured.options;
  const runRoot = await fs.mkdtemp(path.join(root, 'run-'));
  const config = {
    root: runRoot,
    prompt: captured.prompt,
    options: plain,
    callbacks: {
      canUseTool: typeof canUseTool === 'function',
      hooks: Object.fromEntries(Object.entries((hooks ?? {}) as Record<string, Array<{ hooks: unknown[] }>>)
        .map(([event, matchers]) => [event, matchers.reduce((count, matcher) => count + matcher.hooks.length, 0)])),
      mcpServers: Object.keys((mcpServers ?? {}) as Record<string, unknown>),
    },
  };
  const bridge = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'claudeAuthoritySdkBridge.mjs')], {
    cwd: runRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      HOME: runRoot, USERPROFILE: runRoot, CLAUDE_CONFIG_DIR: runRoot },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  bridge.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  bridge.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  bridge.stdin.end(`${JSON.stringify(config)}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.once('close', resolve);
  });
  if (code !== 0) throw new Error(`SDK bridge exit ${code}: ${Buffer.concat(stderr).toString().slice(0, 2000)}`);
  const result = Buffer.concat(stdout).toString().trim().split('\n').map(line => JSON.parse(line) as { type?: string; subtype?: string });
  expect(result.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
  return JSON.parse(await fs.readFile(path.join(runRoot, 'peer-record.json'), 'utf8')) as PeerRecord;
}

it.each(['stable', 'per-turn'] as const)('starts Claude Code with FLUJO as the only approval gate (%s instructions)', async policy => {
  const record = await runInstalledSdk(await adapterQuery(policy));
  // Claude Code must ask FLUJO for every call: the default mode, no settings
  // files (their saved consents and auto-mode rules), no allow list, no skip.
  expect(record.argv).toEqual(expect.arrayContaining([
    '--permission-mode=default', '--setting-sources=', '--permission-prompt-tool=stdio', '--tools=',
  ]));
  expect(record.argv.filter(arg => /^--(?:allowedTools|allowed-tools|dangerously-skip-permissions|allow-dangerously-skip-permissions)/.test(arg)))
    .toEqual([]);
  const disallowed = record.argv.find(arg => arg.startsWith('--disallowedTools='))?.split('=')[1].split(',') ?? [];
  expect(disallowed).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task', 'Agent']));

  const initialize = record.controlRequests.find(request => request.subtype === 'initialize');
  expect(initialize?.hooks?.PreToolUse?.[0]?.hookCallbackIds).toHaveLength(1);
  expect(initialize).toMatchObject({ sdkMcpServers: ['flujo'], systemPrompt: ['Stable instructions'],
    systemPromptSnapshot: policy === 'stable' });

  // FLUJO composes the prompt; Claude Code must not run `/clear` or expand `@path`.
  expect(record.userMessages).toEqual([expect.objectContaining({
    client_composed: true, message: expect.objectContaining({ content: '/clear\n@path\n@server:resource\n/slash text' }),
  })]);
});
