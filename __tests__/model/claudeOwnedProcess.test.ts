import { once } from 'node:events';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeOwnedProcessSpawner } from '@/backend/services/model/adapters/claudeOwnedProcess';

const script = `process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.OWNED_CHILD_VALUE})+'\\n');
process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),250));`;

describe('Claude actual owned child seam', () => {
  it('registers OS birth identity and waits for actual delayed exit after SDK-style EOF Stop', async () => {
    const register = jest.fn(async () => {});
    const forwarded = new AbortController();
    const hook = createClaudeOwnedProcessSpawner({ register, requestSdkStop: () => child.stdin.end() });
    const child: SpawnedProcess = hook.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', script],
      cwd: process.cwd(), env: { ...process.env, OWNED_CHILD_VALUE: 'preserved' }, signal: forwarded.signal });
    try {
      const stdout = once(child.stdout, 'data');
      const registration = await hook.ready;
      const [data] = await stdout;
      expect(JSON.parse(String(data))).toEqual({ cwd: process.cwd(), value: 'preserved' });
      expect(registration.identity.pid).toBeGreaterThan(0);
      expect(registration.identity.processBirthMarkerV2).toMatch(/^(win32|linux|darwin)-v2:/);
      expect(register).toHaveBeenCalledWith(registration);
      let exited = false;
      void registration.exit.then(() => { exited = true; });
      registration.requestStop();
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(exited).toBe(false);
      expect(await registration.exit).toEqual({ code: 0, signal: null });
      await registration.close;
      expect(() => hook.spawnClaudeCodeProcess({ command: process.execPath, args: [], env: {}, signal: forwarded.signal }))
        .toThrow('cannot be reused');
    } finally { child.kill('SIGKILL'); }
  }, 15000);

  it('keeps Stop as a request and honors the SDK forwarded cancellation signal', async () => {
    const forwarded = new AbortController();
    const requestSdkStop = jest.fn();
    const hook = createClaudeOwnedProcessSpawner({ register: async () => {}, requestSdkStop });
    const child = hook.spawnClaudeCodeProcess({ command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'], env: { ...process.env }, signal: forwarded.signal });
    try {
      const registration = await hook.ready;
      registration.requestStop();
      expect(requestSdkStop).toHaveBeenCalledTimes(1);
      expect(child.exitCode).toBeNull();
      forwarded.abort();
      await registration.exit;
      await registration.close;
    } finally { child.kill('SIGKILL'); }
  }, 15000);

  it('rejects refused registration and requests SDK shutdown without inventing exit', async () => {
    const stop = jest.fn(() => child.stdin.end());
    const hook = createClaudeOwnedProcessSpawner({ register: async () => { throw new Error('ledger refused'); }, requestSdkStop: stop });
    const child: SpawnedProcess = hook.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', script], env: { ...process.env }, signal: new AbortController().signal });
    const exit = new Promise(resolve => child.once('exit', resolve));
    try {
      await expect(hook.ready).rejects.toThrow('ledger refused');
      expect(stop).toHaveBeenCalledTimes(1);
      await exit;
    } finally { child.kill('SIGKILL'); }
  }, 15000);

  it('rejects an actual failed spawn without registering a PID or exit receipt', async () => {
    const register = jest.fn(async () => {});
    const hook = createClaudeOwnedProcessSpawner({ register, requestSdkStop: () => {} });
    hook.spawnClaudeCodeProcess({ command: 'flujo-nonexistent-owned-child-01a103ab', args: [],
      env: {}, signal: new AbortController().signal });
    await expect(hook.ready).rejects.toMatchObject({ code: 'ENOENT' });
    expect(register).not.toHaveBeenCalled();
  });
});
