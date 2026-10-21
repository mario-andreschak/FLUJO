import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDirectory, createPrivateDirectory, createPrivateFile, readPrivateFile } from './private-storage.js';
import { type LocalRuntimePolicy, RuntimeControlError } from './local-runtime-policy.js';

/** Only an explicit local Unix socket/named pipe. No inherited Docker context,
 * remote host, shell, credential helper, image pull or provider fallback. */
export class LocalEngine {
  private readonly directory: string;
  constructor(stateDirectory: string) {
    assertPrivateDirectory(stateDirectory);
    this.directory = join(stateDirectory, 'local-engine');
    if (!existsSync(this.directory)) createPrivateDirectory(this.directory);
    assertPrivateDirectory(this.directory);
    const filename = join(this.directory, 'config.json');
    if (!existsSync(filename)) {
      const fd = createPrivateFile(filename);
      try { writeFileSync(fd, '{}\n'); } finally { closeSync(fd); }
    }
    if (readPrivateFile(filename, 16).toString('utf8').trim() !== '{}') {
      throw new RuntimeControlError('local-engine-unavailable');
    }
  }

  spawn(policy: LocalRuntimePolicy, args: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn(policy.executable, ['--host', policy.daemon, '--config', this.directory, ...args], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.directory,
      env: process.platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
          PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), HOME: this.directory, NODE_ENV: 'production' }
        : { PATH: '/usr/bin:/bin', HOME: this.directory, NODE_ENV: 'production' },
    });
  }

  async run(policy: LocalRuntimePolicy, args: readonly string[], input?: string): Promise<string> {
    const child = this.spawn(policy, args);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) stop();
        else chunks.push(chunk);
      });
      // Consume bounded diagnostics without retaining credential-bearing output.
      child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 512 * 1024) stop(); });
      child.on('error', stop); child.stdin.on('error', stop); child.stdin.end(input);
      child.on('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0) reject(new RuntimeControlError('local-engine-unavailable'));
        else resolve(Buffer.concat(chunks).toString('utf8').trim());
      });
    });
  }

  async json(policy: LocalRuntimePolicy, args: readonly string[]): Promise<unknown> {
    try { return JSON.parse(await this.run(policy, args)); }
    catch { throw new RuntimeControlError('local-engine-unavailable'); }
  }
}
