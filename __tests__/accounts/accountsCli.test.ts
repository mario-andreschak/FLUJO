import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { accountsFileSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SCRYPT_MAXMEM_BYTES, SCRYPT_PARAMETERS, USER_NAME_PATTERN, WORKSPACE_NAME_PATTERN } from '@/shared/types/accounts';
import { verifyPassword } from '@/backend/services/accounts/passwords';
import { signIn } from '@/backend/services/accounts/signIn';
import { loadAccountsState, loadSessions } from '@/backend/services/accounts/store';
import { useTemporaryDataDir } from './helpers';

/**
 * The server command line (`node bin/flujo.mjs users …`, `npm run users`)
 * writes files the running server accepts, and is the way back in after a
 * forgotten admin password or a damaged accounts file (#574).
 */

const CLI = path.join(process.cwd(), 'scripts', 'accounts-cli.mjs');

function run(args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('users command line', () => {
  let restore: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    ({ dir, restore } = await useTemporaryDataDir());
    await fs.mkdir(path.join(dir, 'workspaces', 'old-work'), { recursive: true });
  });
  afterAll(async () => restore());

  it('uses the same rules as the server', async () => {
    const probe = spawn(process.execPath, ['--input-type=module', '-e',
      `const cli = await import(${JSON.stringify(pathToFileURL(CLI).href)});
       const show = value => value instanceof RegExp ? { regex: value.source } : value;
       console.log(JSON.stringify(Object.fromEntries(Object.entries(cli).map(([key, value]) => [key, show(value)]))));`]);
    let text = '';
    probe.stdout.on('data', chunk => { text += chunk; });
    await new Promise(resolve => probe.on('close', resolve));
    const raw = JSON.parse(text) as Record<string, unknown>;
    const regex = (value: unknown) => new RegExp((value as { regex: string }).regex);
    const cli: Record<string, unknown> = { ...raw, USER_NAME_PATTERN: regex(raw.USER_NAME_PATTERN), WORKSPACE_NAME_PATTERN: regex(raw.WORKSPACE_NAME_PATTERN) };
    expect(cli.USER_NAME_PATTERN).toEqual(USER_NAME_PATTERN);
    expect(cli.WORKSPACE_NAME_PATTERN).toEqual(WORKSPACE_NAME_PATTERN);
    expect(cli.PASSWORD_MIN_LENGTH).toBe(PASSWORD_MIN_LENGTH);
    expect(cli.PASSWORD_MAX_LENGTH).toBe(PASSWORD_MAX_LENGTH);
    expect(cli.SCRYPT).toEqual({ ...SCRYPT_PARAMETERS, maxmem: SCRYPT_MAXMEM_BYTES });
  });

  it('turns the mode on, adds people, resets a password and turns it off', async () => {
    const data = ['--data', dir, '--password-stdin'];
    expect((await run(['init', 'Root', ...data], 'short\n'))).toMatchObject({ code: 1, stderr: expect.stringMatching(/at least 15/) });
    const init = await run(['init', 'Root', ...data], 'the first admin passphrase\n');
    expect(init).toMatchObject({ code: 0, stdout: expect.stringMatching(/first admin/) });
    let state = await loadAccountsState();
    expect(state.mode).toBe('on');
    accountsFileSchema.parse(state.accounts);
    const root = state.accounts!.users[0];
    expect(root).toMatchObject({ name: 'root', role: 'admin', hostAccess: true });
    expect(state.accounts!.workspaces).toMatchObject({
      'default-workspace': { ownerId: root.id }, 'old-work': { ownerId: root.id },
    });
    expect(await verifyPassword('the first admin passphrase', root.passwordHash)).toEqual({ ok: true, needsRehash: false });

    expect((await run(['add', 'anna', ...data], 'anna has a long passphrase\n')).code).toBe(0);
    await signIn('anna', 'anna has a long passphrase');
    expect((await loadSessions()).sessions).toHaveLength(1);

    expect((await run(['reset-password', 'anna', ...data], 'a brand new passphrase for anna\n')).code).toBe(0);
    expect((await loadSessions()).sessions).toHaveLength(0);
    await expect(signIn('anna', 'anna has a long passphrase')).rejects.toMatchObject({ status: 401 });

    expect((await run(['disable', 'root', ...data])).stderr).toMatch(/at least one active admin/);
    expect((await run(['assign', 'old-work', 'anna', ...data])).code).toBe(0);
    expect((await run(['disable', 'anna', ...data])).code).toBe(0);
    state = await loadAccountsState();
    accountsFileSchema.parse(state.accounts);
    expect(state.accounts!.users.find(user => user.name === 'anna')).toMatchObject({ disabled: true, generation: 3 });
    expect(state.accounts!.workspaces['old-work'].ownerId).not.toBe(root.id);

    const list = await run(['list', '--data', dir]);
    expect(list.stdout).toMatch(/anna\s+member\s+turned off/);
    expect(list.stdout).toMatch(/workspace old-work: anna/);

    expect((await run(['off', '--data', dir])).code).toBe(0);
    expect((await loadAccountsState()).mode).toBe('off');
    expect((await run(['on', '--data', dir])).stdout).toMatch(/on again/);
    expect((await loadAccountsState()).mode).toBe('on');
  }, 120_000);

  it('switches a damaged accounts file off so FLUJO works again', async () => {
    await fs.writeFile(path.join(dir, 'accounts', 'accounts.json'), 'broken');
    await fs.writeFile(path.join(dir, 'accounts', 'accounts.json.bak'), 'broken too');
    expect((await loadAccountsState()).mode).toBe('damaged');
    expect((await run(['list', '--data', dir])).stderr).toMatch(/damaged/);
    const off = await run(['off', '--data', dir]);
    expect(off).toMatchObject({ code: 0, stdout: expect.stringMatching(/moved to/) });
    expect((await loadAccountsState()).mode).toBe('off');
  });
});
