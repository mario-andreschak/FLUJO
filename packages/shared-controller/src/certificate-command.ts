import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { assertPrivateDirectory } from './private-storage.js';

/** Fixed local certificate operations only; no shell or inherited OpenSSL,
 * proxy, credential-helper or provider configuration. Diagnostics stay private. */
export async function certificateCommand(executable: string, args: readonly string[], directory: string,
  input = '', configFile?: string): Promise<Buffer> {
  if (!isAbsolute(executable)) throw new Error('Absolute certificate tool required.');
  assertPrivateDirectory(directory);
  const child = spawn(executable, args, { shell: false, windowsHide: true, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'production', HOME: directory,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
        PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') } : { PATH: '/usr/bin:/bin' }),
      ...(configFile ? { OPENSSL_CONF: configFile } : {}),
    } });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0; let failed = false; let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (failed || settled) return;
      failed = true;
      child.kill('SIGKILL');
      grace = setTimeout(() => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        reject(new Error('Local certificate command exit is unconfirmed.'));
      }, 5000);
    };
    const timeout = setTimeout(fail, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) fail(); else if (!failed) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) fail(); });
    child.on('error', fail); child.stdin.on('error', fail); child.stdin.end(input);
    child.once('close', code => {
      clearTimeout(timeout); clearTimeout(grace);
      if (settled) return;
      settled = true;
      if (failed || code !== 0) reject(new Error('Local certificate command failed.'));
      else resolve(Buffer.concat(chunks));
    });
  });
}
