// Actual installed Agent SDK in its own Node process (Jest cannot load its ESM
// build). It receives the query options FLUJO's adapter built, keeps every
// plain value, and supplies stand-ins only for the callbacks that cannot cross
// a process boundary. The Claude Code process it starts is a fake that records
// what the SDK started it with and sent to it (`config.peer`, default
// claudeAuthorityCliPeer.cjs, given `config.peerArgs` before the SDK's own).
// With `config.runtime` ({ cwd, env }) it starts the SDK's bundled Claude Code
// instead, in that folder with only that environment.
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const lines = createInterface({ input: process.stdin });
const first = await lines[Symbol.asyncIterator]().next();
lines.close();
const config = JSON.parse(first.value);
const recordFile = path.join(config.root, 'peer-record.json');
const system = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
let peer;
let drained;
async function* prompt() { yield config.prompt; }
const response = query({ prompt: prompt(), options: {
  ...config.options,
  cwd: config.runtime?.cwd ?? config.root,
  env: config.runtime ? { ...system, ...config.runtime.env } : { HOME: config.root, USERPROFILE: config.root,
    CLAUDE_CONFIG_DIR: config.root, CLAUDE_CODE_OAUTH_TOKEN: 'offline-not-a-secret' },
  ...(config.callbacks.canUseTool ? { canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) } : {}),
  hooks: Object.fromEntries(Object.entries(config.callbacks.hooks).map(([event, count]) =>
    [event, [{ hooks: Array.from({ length: count }, () => async () => ({})) }]])),
  mcpServers: Object.fromEntries(config.callbacks.mcpServers.map(name =>
    [name, createSdkMcpServer({ name, version: '1.0.0', tools: [] })])),
  spawnClaudeCodeProcess: options => {
    const peerFile = fileURLToPath(new URL(`./${config.peer ?? 'claudeAuthorityCliPeer.cjs'}`, import.meta.url));
    peer = config.runtime
      ? spawn(options.command, options.args, { cwd: options.cwd, env: options.env, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal })
      : spawn(process.execPath, [peerFile, recordFile, ...(config.peerArgs ?? []), ...options.args], {
        cwd: config.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
        env: { ...system, HOME: config.root, USERPROFILE: config.root },
      });
    drained = new Promise(resolve => peer.once('close', resolve));
    peer.stderr.on('data', chunk => process.stderr.write(chunk));
    return peer;
  },
} });
try {
  for await (const message of response) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    if (message.type === 'result') break;
  }
} finally {
  response.close();
  if (peer && peer.exitCode === null && peer.signalCode === null) peer.stdin.end();
  if (drained) await drained;
}
