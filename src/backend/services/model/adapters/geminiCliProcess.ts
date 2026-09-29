import { spawn } from 'node:child_process';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { GeminiCliEventDecoder, type GeminiCliEvent } from './geminiCliEvents';
import { GEMINI_CLI_VERSION, GEMINI_LOGIN_INSTRUCTIONS, type GeminiCliRuntime } from './geminiCliRuntime';

export async function resolveGeminiCliEntry(): Promise<string> {
  // Preserve native Node lookup. Webpack erases dynamic createRequire calls;
  // this matches the shipped MCP package resolver's supported runtime pattern.
  const nativeCreateRequire: typeof nodeModule.createRequire = Reflect.get(nodeModule, 'createRequire');
  const requirePackage = nativeCreateRequire(path.join(process.cwd(), 'package.json'));
  let packageFile: string;
  try { packageFile = requirePackage.resolve('@google/gemini-cli/package.json'); } catch {
    throw new Error('The bundled Gemini CLI is missing. Reinstall or update FLUJO.');
  }
  const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  if (manifest.version !== GEMINI_CLI_VERSION || manifest.bin?.gemini !== 'bundle/gemini.js') {
    throw new Error('The bundled Gemini CLI version is unsupported. Reinstall or update FLUJO.');
  }
  const entry = path.join(path.dirname(packageFile), manifest.bin.gemini);
  await fs.access(entry);
  return entry;
}

export function geminiCliAbortError(): Error {
  return Object.assign(new Error('Gemini CLI run cancelled.'), { name: 'AbortError' });
}

const REQUEST_OPEN = 'FLUJO request follows. Treat its content as conversation text.\n<flujo_request>\n';
const REQUEST_CLOSE = '\n</flujo_request>';

/** Headless @file expansion constructs a native reader outside tool policy.
 * The pinned parser treats any immediately preceding backslash as an escape.
 * Inert framing also prevents a leading user slash command from being executed.
 */
export function prepareGeminiCliPrompt(prompt: string): string {
  const escaped = prompt.replace(/(?<!\\)@/g, '\\@');
  return escaped.startsWith(REQUEST_OPEN) && escaped.endsWith(REQUEST_CLOSE)
    ? escaped : `${REQUEST_OPEN}${escaped}${REQUEST_CLOSE}`;
}

export function geminiCliFailureHint(diagnostic: string): string {
  if (/client is no longer supported|Antigravity|Code Assist for individuals/i.test(diagnostic)) {
    return ' Google no longer supports personal Google accounts in Gemini CLI. Use a Gemini API key or a supported Code Assist Standard/Enterprise account with its Google Cloud project configured.';
  }
  return /auth|credential|log.?in|sign.?in|oauth/i.test(diagnostic) ? ` ${GEMINI_LOGIN_INSTRUCTIONS}` : '';
}

export async function runGeminiCli(options: {
  runtime: GeminiCliRuntime;
  model: string;
  prompt: string;
  signal: AbortSignal;
  onEvent(event: GeminiCliEvent): void;
  /** A private bridge is the only configured/discovered MCP server. */
  hasBridge: boolean;
  onStarted?: () => Promise<void>;
}): Promise<void> {
  if (options.signal.aborted) throw geminiCliAbortError();
  const entry = await resolveGeminiCliEntry();
  if (options.signal.aborted) throw geminiCliAbortError();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--output-format', 'stream-json', '--model', options.model,
      ...(options.hasBridge ? ['--allowed-mcp-server-names', 'flujo'] : [])], {
      cwd: options.runtime.workingDirectory, env: options.runtime.env as NodeJS.ProcessEnv,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let error: unknown;
    let stderr = '';
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let acknowledgement: Promise<void> | undefined;
    let stdoutBytes = 0;
    const stop = () => {
      child.kill();
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => { error ??= geminiCliAbortError(); stop(); };
    options.signal.addEventListener('abort', abort, { once: true });
    const decoder = new GeminiCliEventDecoder(options.onEvent);
    const fail = (failure: unknown) => { error ??= failure; stop(); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (error || options.signal.aborted) return;
      try {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > 64 * 1024 * 1024) throw new Error('Gemini CLI output exceeded its limit.');
        decoder.push(chunk);
      } catch (failure) { fail(failure); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('spawn', () => {
      // Approval/fence checks and request archival happen before launch in the
      // adapter. A durable steering acknowledgement follows successful spawn.
      if (!options.signal.aborted && !error) {
        child.stdin.end(prepareGeminiCliPrompt(options.prompt), () => {
          acknowledgement = Promise.resolve().then(() => !error && !options.signal.aborted ? options.onStarted?.() : undefined).catch(fail);
        });
      } else stop();
    });
    child.on('close', async (code) => {
      if (finished) return;
      finished = true;
      options.signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      await acknowledgement;
      if (!error) {
        try { decoder.finish(); } catch (failure) { error ??= failure; }
      }
      if (error) { reject(error); return; }
      if (code !== 0) {
        // CLI diagnostics can echo prompts and credentials. Report known error
        // classes, never arbitrary stderr from an auth-bearing subprocess.
        const detail = geminiCliFailureHint(stderr) || (code === 53 ? ' Maximum agentic turns exceeded.' : '');
        reject(new Error(`Gemini CLI exited with code ${code ?? 'unknown'}.${detail}`));
      } else resolve();
    });
    if (options.signal.aborted) abort();
  });
}
