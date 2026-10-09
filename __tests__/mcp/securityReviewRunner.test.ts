import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const spawnMock = jest.fn();
jest.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
import { runSkillSpector, scannerSourceArchive } from '@/backend/services/mcp/securityReview/runner';

const image = `sha256:${'a'.repeat(64)}`, seedId = 'b'.repeat(64), scannerId = 'c'.repeat(64);
const files = [{ path: 'SKILL.md', content: Buffer.from('Untrusted bytes only') }];
type Reply = { output?: string; code?: number; hang?: boolean };
let owner: string, seed: string, scanner: string, volume: string;
let override: (args: string[]) => Reply | undefined;
const killed: string[][] = [];
const previousImage = process.env.FLUJO_SKILLSPECTOR_IMAGE;
function reply(args: string[]): Reply {
  if (args[0] === 'image') return { output: JSON.stringify([{ Id: image, Os: 'linux', Config: { User: '1000:1000', Entrypoint: ['/opt/scanner/.venv/bin/skillspector'], Labels: {
    'org.flujo.skillspector.version': '2.12.0', 'org.flujo.skillspector.revision': 'c7958a3268d9498644b22edb75d0f051bbc8cbfc',
    'org.flujo.skillspector.wheel-sha256': '62973f6254d30c871480246869f88a01e17dff6f12e9d43010962eb0d7e305f4',
  } } }]) };
  if (args[0] === 'volume' && args[1] === 'create') {
    owner = args[args.indexOf('--label') + 1].split('=')[1]; volume = args.at(-1)!;
    return { output: volume };
  }
  if (args[0] === 'create') {
    const name = args[args.indexOf('--name') + 1];
    if (name.endsWith('-seed')) seed = name; else scanner = name;
    return { output: name.endsWith('-seed') ? seedId : scannerId };
  }
  if (args[0] === 'container' && args[1] === 'inspect') return { output: JSON.stringify([{ Id: args[2] === seed ? seedId : scannerId, Image: image, Config: { Labels: { 'org.flujo.security-review.owner': owner } } }]) };
  if (args[0] === 'inspect') return { output: JSON.stringify({ Running: false, OOMKilled: false, ExitCode: 1 }) };
  if (args[0] === 'start') return { output: '{"issues":[{"severity":"HIGH"}]}' };
  if (args[0] === 'ps') return { output: args.join(' ').includes('-seed') ? seedId : scannerId };
  if (args[0] === 'volume' && args[1] === 'ls') return { output: volume };
  if (args[0] === 'volume' && args[1] === 'inspect') return { output: JSON.stringify([{ Name: volume, Labels: { 'org.flujo.security-review.owner': owner } }]) };
  return {};
}
beforeEach(() => {
  jest.useRealTimers(); spawnMock.mockReset(); killed.length = 0;
  owner = seed = scanner = volume = ''; override = () => undefined;
  process.env.FLUJO_SKILLSPECTOR_IMAGE = image;
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: jest.Mock };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = (code: number) => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = jest.fn(() => { killed.push(args); process.nextTick(() => close(137)); return true; });
    process.nextTick(() => {
      const normal = reply(args), response = override(args) ?? normal;
      if (response.hang) return;
      if (response.output) child.stdout.write(response.output);
      close(response.code ?? 0);
    });
    return child;
  });
});
afterAll(() => {
  if (previousImage === undefined) delete process.env.FLUJO_SKILLSPECTOR_IMAGE;
  else process.env.FLUJO_SKILLSPECTOR_IMAGE = previousImage;
});
const calls = () => spawnMock.mock.calls.map(call => call[1] as string[]);
const run = (signal = new AbortController().signal) => runSkillSpector(files, signal);

it('rejects mutable engine selectors without starting any command', async () => {
  process.env.FLUJO_SKILLSPECTOR_IMAGE = 'skillspector:latest';
  await expect(run()).rejects.toThrow(); expect(spawnMock).not.toHaveBeenCalled();
});
it('rejects wrong engine provenance before allocating source or scanner resources', async () => {
  override = args => args[0] === 'image' ? { output: JSON.stringify([{ Id: image, Os: 'linux', Config: { User: 'root' } }]) } : undefined;
  await expect(run()).rejects.toThrow();
  expect(calls()).toHaveLength(1);
});
it('retains findings exit1, uses only owned source volume, and keeps credentials out of child environment', async () => {
  process.env.SKILLSPECTOR_TEST_PRIVATE_TOKEN = 'do-not-forward';
  try {
    expect(await run()).toMatchObject({ exitCode: 1, imageId: image, stdout: expect.stringContaining('HIGH') });
    const create = calls().find(args => args[0] === 'create' && !args.includes(seed))!;
    expect(create).toEqual(expect.arrayContaining(['--pull=never', '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '1000:1000', '--no-llm', '--format', 'json', '--fail-on-incomplete']));
    expect(create[create.indexOf('--mount') + 1]).toBe(`type=volume,src=${volume},dst=/input,readonly,volume-nocopy`);
    expect(create.join(' ')).not.toMatch(/type=bind|\/var\/run\/docker\.sock/);
    for (const [command, , options] of spawnMock.mock.calls) {
      expect(command).toBe('docker'); expect(options.shell).toBe(false); expect(options.windowsHide).toBe(true);
      expect(options.env.SKILLSPECTOR_TEST_PRIVATE_TOKEN).toBeUndefined();
    }
    expect(calls()).toContainEqual(['rm', '--force', scannerId]);
    expect(calls()).toContainEqual(['rm', '--force', seedId]);
    expect(calls()).toContainEqual(['volume', 'rm', volume]);
    expect(calls().some(args => args[0] === 'start' && args.includes(seedId))).toBe(false);
  } finally { delete process.env.SKILLSPECTOR_TEST_PRIVATE_TOKEN; }
});
it('kills an aborted attached client and awaits all owned cleanup', async () => {
  const controller = new AbortController();
  override = args => { if (args[0] !== 'start') return undefined; process.nextTick(() => controller.abort()); return { hang: true }; };
  await expect(run(controller.signal)).rejects.toThrow();
  expect(killed).toContainEqual(['start', '--attach', scannerId]);
  expect(calls()).toContainEqual(['rm', '--force', scannerId]);
  expect(calls()).toContainEqual(['rm', '--force', seedId]);
  expect(calls()).toContainEqual(['volume', 'rm', volume]);
});
it('reconciles a lost create response but never deletes a foreign scanner', async () => {
  override = args => {
    if (args[0] === 'create' && !args.includes(seed)) return { code: 1 };
    if (args[0] === 'container' && args[2] === scanner) return { output: JSON.stringify([{ Id: scannerId, Image: image, Config: { Labels: { 'org.flujo.security-review.owner': 'foreign' } } }]) };
    return undefined;
  };
  await expect(run()).rejects.toThrow();
  expect(calls().some(args => args[0] === 'ps' && args.join(' ').includes(scanner))).toBe(true);
  expect(calls()).not.toContainEqual(['rm', '--force', scannerId]);
  expect(calls()).toContainEqual(['rm', '--force', seedId]);
  expect(calls()).toContainEqual(['volume', 'rm', volume]);
});
it('continues seed and volume cleanup after scanner deletion fails and refuses successful review', async () => {
  override = args => args[0] === 'rm' && args.includes(scannerId) ? { code: 1 } : undefined;
  await expect(run()).rejects.toThrow(/cleanup/i);
  expect(calls()).toContainEqual(['rm', '--force', seedId]);
  expect(calls()).toContainEqual(['volume', 'rm', volume]);
});
it('kills excessive scanner output then performs guarded resource cleanup', async () => {
  override = args => args[0] === 'start' ? { output: 'x'.repeat(4 * 1024 * 1024 + 1) } : undefined;
  await expect(run()).rejects.toThrow(/output exceeded/);
  expect(killed).toContainEqual(['start', '--attach', scannerId]);
  expect(calls()).toContainEqual(['volume', 'rm', volume]);
});
it('times out a hanging attached client and waits for cleanup before rejecting', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  let started: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  override = args => { if (args[0] !== 'start') return undefined; started(); return { hang: true }; };
  try {
    const pending = run();
    const rejected = expect(pending).rejects.toThrow(/time limit/);
    await ready;
    await jest.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(killed).toContainEqual(['start', '--attach', scannerId]);
    expect(calls()).toContainEqual(['rm', '--force', scannerId]);
    expect(calls()).toContainEqual(['rm', '--force', seedId]);
    expect(calls()).toContainEqual(['volume', 'rm', volume]);
  } finally { jest.useRealTimers(); }
});
it.each([
  [{ path: '../x', content: Buffer.alloc(0) }],
  [{ path: 'x', content: Buffer.alloc(0) }, { path: 'X', content: Buffer.alloc(0) }],
  [{ path: 'Dir/a', content: Buffer.alloc(0) }, { path: 'dir/b', content: Buffer.alloc(0) }],
  [{ path: 'x', content: Buffer.alloc(0) }, { path: 'x/a', content: Buffer.alloc(0) }],
  [{ path: 'x', content: Buffer.alloc(1024 * 1024 + 1) }],
])('refuses invalid archive before Docker effects', async bad => {
  expect(() => scannerSourceArchive(bad)).toThrow();
  await expect(runSkillSpector(bad, new AbortController().signal)).rejects.toThrow();
  expect(spawnMock).not.toHaveBeenCalled();
});
