// Actual installed Agent SDK in a separate Node process: no Jest ESM stand-in
// replaces its protocol. The spawned CLI peer below is a controlled fixture.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const lines = createInterface({ input: process.stdin });
const first = await lines[Symbol.asyncIterator]().next();
lines.close();
const config = JSON.parse(first.value);
const url = new URL(config.url);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fixture');
let peer;
let drained;
const response = query({ prompt: config.prompt, options: {
  model: 'offline-model', cwd: config.root, settingSources: [], tools: [], maxTurns: 1,
  executable: process.execPath,
  env: { HOME: config.root, USERPROFILE: config.root, CLAUDE_CONFIG_DIR: config.root,
    CLAUDE_CODE_OAUTH_TOKEN: 'offline-not-a-secret' },
  spawnClaudeCodeProcess: options => {
    peer = spawn(process.execPath, [fileURLToPath(new URL('./claudeArchiveCliPeer.cjs', import.meta.url)), config.url], {
      cwd: config.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        HOME: config.root, USERPROFILE: config.root, CLAUDE_CONFIG_DIR: config.root },
    });
    drained = new Promise((resolve, reject) => {
      peer.once('error', reject);
      peer.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`CLI peer exit ${code}/${signal}`)));
    });
    // Avoid unhandled rejection during SDK teardown, but await the original.
    drained.catch(() => undefined);
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
