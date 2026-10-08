import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { prepareLocalInstance, readPrivateJson, createLocalInstanceProof, withLocalInstanceHostname } from '../../scripts/local-instance.mjs';
import { forwardNextShutdown } from '../../scripts/launch-next.mjs';

jest.mock('@next/env', () => ({ __esModule: true, default: { loadEnvConfig: jest.fn() } }));

jest.setTimeout(60000);
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-instance-test-')); });
afterEach(async () => {
  expect(path.basename(root)).toMatch(/^flujo-instance-test-/);
  await fs.rm(root, { recursive: true, force: true });
});
const environment = () => ({ FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_LOCAL_INSTANCE_DIR: path.join(root, 'instances'),
  FLUJO_DATA_DIR: path.join(root, 'data') });

it('generates and privately registers a unique native instance with the actual child identity', async () => {
  const instance = await prepareLocalInstance({ env: environment(), args: ['start', '-p', '4210', '-H', '127.0.0.1'], appRoot: root });
  expect(instance.env.FLUJO_SNAPSHOT_CONTROL_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await instance.register(process.pid);
  const filename = path.join(root, 'instances', `${instance.env.FLUJO_LOCAL_INSTANCE_ID}.json`);
  const record = await readPrivateJson(filename);
  expect(record).toMatchObject({ format: 'flujo-local-instance', version: 1, pid: process.pid,
    origin: 'http://127.0.0.1:4210', appRoot: root, dataRoot: path.join(root, 'data'),
    token: instance.env.FLUJO_SNAPSHOT_CONTROL_TOKEN });
  const nonce = 'a'.repeat(64);
  const proof = createLocalInstanceProof(nonce, instance.env);
  expect(proof?.proof).toBe(createHmac('sha256', record.token)
    .update(`flujo-local-instance:v1\n${nonce}\n${record.instanceId}\n${record.origin}`).digest('base64url'));
  expect(JSON.stringify(proof)).not.toContain(record.token);
  instance.cleanup();
  await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves an explicit token and creates independent descriptors for separate launches', async () => {
  const env = { ...environment(), FLUJO_SNAPSHOT_CONTROL_TOKEN: 'synthetic-explicit-source-token-0123456789' };
  const first = await prepareLocalInstance({ env, appRoot: root });
  const second = await prepareLocalInstance({ env, appRoot: root });
  expect(first.env.FLUJO_SNAPSHOT_CONTROL_TOKEN).toBe(env.FLUJO_SNAPSHOT_CONTROL_TOKEN);
  expect(first.env.FLUJO_LOCAL_INSTANCE_ID).not.toBe(second.env.FLUJO_LOCAL_INSTANCE_ID);
  await first.register(process.pid);
  await second.register(process.pid);
  expect(await fs.readdir(path.join(root, 'instances'))).toHaveLength(2);
  first.cleanup();
  second.cleanup();
});

it.each([
  { FLUJO_WORKER_MODE: '1' }, { FLUJO_CONTAINER: '1' }, { FLUJO_EXPOSURE_MODE: 'network' }, { FLUJO_EXPOSURE_MODE: 'public' },
])('skips auto credentials and registration for unsupported mode %j', async (override) => {
  const instance = await prepareLocalInstance({ env: { ...environment(), ...override }, appRoot: root });
  await instance.register(process.pid);
  expect(instance.env.FLUJO_SNAPSHOT_CONTROL_TOKEN).toBeUndefined();
  expect(instance.env.FLUJO_LOCAL_INSTANCE_ID).toBeUndefined();
  await expect(fs.stat(path.join(root, 'instances'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not auto-enable capture for explicit wildcard binds and rejects linked registries', async () => {
  const skipped = await prepareLocalInstance({ env: environment(), args: ['start', '-H', '0.0.0.0'], appRoot: root });
  expect(skipped.env.FLUJO_SNAPSHOT_CONTROL_TOKEN).toBeUndefined();
  const target = path.join(root, 'target');
  await fs.mkdir(target);
  await fs.symlink(target, path.join(root, 'instances'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(prepareLocalInstance({ env: environment(), appRoot: root })).rejects.toThrow(/unsafe/);
});

it('rejects registry overrides inside a workspace before creating private credentials there', async () => {
  const directory = path.join(root, 'data', 'workspaces', 'test', 'db', 'instances');
  await expect(prepareLocalInstance({ env: { ...environment(), FLUJO_LOCAL_INSTANCE_DIR: directory }, appRoot: root }))
    .rejects.toThrow(/outside workspace snapshots/);
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([['-H', 'localhost'], ['--hostname', 'localhost'], ['--hostname=localhost']])(
  'uses one numeric bind and proof origin for explicit localhost arguments %j', async (...hostnameArgs) => {
    const args = ['start', '-p', '4210', ...hostnameArgs];
    const normalized = withLocalInstanceHostname(args, environment());
    expect(normalized.join(' ')).not.toContain('localhost');
    expect(normalized.join(' ')).toContain('127.0.0.1');
    expect(args.join(' ')).toContain('localhost');
    const instance = await prepareLocalInstance({ env: environment(), args: normalized, appRoot: root });
    expect(instance.env.FLUJO_LOCAL_INSTANCE_ORIGIN).toBe('http://127.0.0.1:4210');
    expect(createLocalInstanceProof('a'.repeat(64), instance.env)?.origin).toBe('http://127.0.0.1:4210');
    instance.cleanup();
  },
);

it('preserves explicitly requested IPv6 and unsupported exposure hostname arguments', async () => {
  const args = ['start', '-p', '4210', '--hostname', '::1'];
  expect(withLocalInstanceHostname(args, environment())).toEqual(args);
  const instance = await prepareLocalInstance({ env: environment(), args, appRoot: root });
  expect(instance.env.FLUJO_LOCAL_INSTANCE_ORIGIN).toBe('http://[::1]:4210');
  instance.cleanup();
  const network = ['start', '--hostname=localhost'];
  expect(withLocalInstanceHostname(network, { FLUJO_EXPOSURE_MODE: 'network' })).toEqual(network);
});

it('native shutdown forwards the signal and removes its private registration', async () => {
  const instance = await prepareLocalInstance({ env: environment(), appRoot: root });
  const registered = instance.register(process.pid);
  await registered;
  const filename = path.join(root, 'instances', `${instance.env.FLUJO_LOCAL_INSTANCE_ID}.json`);
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: jest.fn() });
  const parent = Object.assign(new EventEmitter(), { platform: 'win32', pid: 1, exit: jest.fn(), kill: jest.fn() });
  forwardNextShutdown(child, instance, registered, { parent: parent as unknown as NodeJS.Process });
  parent.emit('SIGTERM');
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  child.emit('exit', null, 'SIGTERM');
  await new Promise(setImmediate);
  expect(parent.exit).toHaveBeenCalledWith(1);
});

it('shutdown waits for registration cleanup before preserving POSIX signal semantics', async () => {
  let finishRegistration!: () => void;
  const registered = new Promise<void>((resolve) => { finishRegistration = resolve; });
  const instance = { cleanup: jest.fn() };
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: jest.fn() });
  const parent = Object.assign(new EventEmitter(), { platform: 'linux', pid: 1, exit: jest.fn(), kill: jest.fn() });
  forwardNextShutdown(child, instance, registered, { parent: parent as unknown as NodeJS.Process });
  parent.emit('SIGINT');
  child.emit('exit', null, 'SIGINT');
  expect(instance.cleanup).toHaveBeenCalledTimes(1);
  expect(parent.kill).not.toHaveBeenCalled();
  finishRegistration();
  await new Promise(setImmediate);
  expect(instance.cleanup).toHaveBeenCalledTimes(2);
  expect(parent.listenerCount('SIGINT')).toBe(0);
  expect(parent.kill).toHaveBeenCalledWith(1, 'SIGINT');
});
