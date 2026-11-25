#!/usr/bin/env node
/**
 * Manage multi-user sign-in from the server machine (#574). Access to the
 * server is the recovery authority: this is how a forgotten admin password is
 * reset, and how a damaged accounts file is switched off.
 *
 *   node bin/flujo.mjs users <command> …      (npm package, data in ~/.flujo)
 *   npm run users -- <command> …              (git checkout, data next to the app)
 *
 * Commands:
 *   list                              people, roles and workspace owners
 *   init <name>                       turn multi-user mode on with a first admin
 *   on | off                          turn the mode on again / off (nothing is deleted)
 *   add <name> [--admin] [--host-access] [--display-name <text>]
 *   disable <name> | enable <name>
 *   reset-password <name>
 *   assign <workspace> <name>         give a workspace to a person
 * Options: --data <folder> (the FLUJO data folder), --password-stdin (read the
 * password from the first line of standard input instead of asking).
 *
 * The file format is fixed in src/shared/types/accounts.ts and the running
 * server checks it on every read; __tests__/accounts/accountsCli.test.ts proves
 * the files written here are accepted there. Passwords never go on the command
 * line, where other people on the machine could see them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes, scrypt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const USER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SCRYPT = Object.freeze({ logN: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32, maxmem: 256 * 1024 * 1024 });
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 256;

class CliError extends Error {}

function hashPassword(password) {
  const salt = randomBytes(SCRYPT.saltBytes);
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, SCRYPT.keyBytes,
      { N: 2 ** SCRYPT.logN, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (error, key) => {
        if (error) reject(error);
        else resolve(`scrypt-v1$${SCRYPT.logN}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`);
      });
  });
}

function checkPassword(password, name) {
  if (password.length < PASSWORD_MIN_LENGTH) throw new CliError(`Use at least ${PASSWORD_MIN_LENGTH} characters. A few ordinary words in a row work well.`);
  if (password.length > PASSWORD_MAX_LENGTH) throw new CliError(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  if (new Set(password.toLowerCase()).size <= 2) throw new CliError('This password is too easy to guess. Choose another one.');
  const folded = password.toLowerCase();
  if (name.length >= 3 && folded.includes(name) && folded.replaceAll(name, '').length < PASSWORD_MIN_LENGTH / 2) {
    throw new CliError('The password must not be mostly the sign-in name.');
  }
}

function paths(dataDir) {
  const directory = path.join(dataDir, 'accounts');
  return {
    directory,
    accounts: path.join(directory, 'accounts.json'),
    backup: path.join(directory, 'accounts.json.bak'),
    sessions: path.join(directory, 'sessions.json'),
    audit: path.join(directory, 'audit.jsonl'),
  };
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${randomBytes(8).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  for (let attempt = 1; ; attempt++) {
    try { await fs.rename(temporary, file); return; }
    catch (error) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20 * attempt));
    }
  }
}

function looksLikeAccounts(value) {
  return value && typeof value === 'object' && value.schemaVersion === 1 && typeof value.enabled === 'boolean'
    && Number.isSafeInteger(value.revision) && Array.isArray(value.users) && Array.isArray(value.teams)
    && value.workspaces && typeof value.workspaces === 'object' && Array.isArray(value.apiTokens);
}

async function readAccounts(files) {
  for (const file of [files.accounts, files.backup]) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (looksLikeAccounts(value)) return { accounts: value, damaged: false };
    } catch (error) {
      if (error.code === 'ENOENT' && file === files.accounts) {
        try { await fs.stat(files.backup); } catch { return { accounts: null, damaged: false }; }
      }
    }
  }
  const exists = await fs.stat(files.accounts).then(() => true, () => false);
  return { accounts: null, damaged: exists };
}

async function saveAccounts(files, accounts) {
  const activeAdmin = accounts.users.some(user => user.role === 'admin' && !user.disabled);
  if (accounts.enabled && !activeAdmin) throw new CliError('There must always be at least one active admin.');
  const next = { ...accounts, revision: accounts.revision + 1 };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await writeAtomic(files.accounts, text);
  await writeAtomic(files.backup, text);
  return next;
}

async function audit(files, action, target, detail) {
  try {
    await fs.mkdir(files.directory, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ at: Date.now(), action, actorUserId: null, ...(target ? { target } : {}), ...(detail ? { detail } : {}) });
    await fs.appendFile(files.audit, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* the audit log never blocks recovery */ }
}

async function endSessions(files, keep) {
  let current;
  try { current = JSON.parse(await fs.readFile(files.sessions, 'utf8')); } catch { return; }
  const sessions = Array.isArray(current?.sessions) ? current.sessions.filter(keep) : [];
  await writeAtomic(files.sessions, `${JSON.stringify({ schemaVersion: 1, sessions })}\n`);
}

async function listWorkspaceNames(dataDir) {
  const names = new Set(['default-workspace']);
  try {
    for (const entry of await fs.readdir(path.join(dataDir, 'workspaces'), { withFileTypes: true })) {
      if (entry.isDirectory() && WORKSPACE_NAME_PATTERN.test(entry.name)) names.add(entry.name);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [...names];
}

async function ownerTokens(userId) {
  const file = process.env.FLUJO_OWNER_AUTH_FILE?.trim();
  if (!file) return [];
  try {
    const policy = JSON.parse(await fs.readFile(file, 'utf8'));
    return (policy.credentials ?? []).map(credential => ({
      id: credential.id, userId, label: 'Copied owner token', digest: credential.digest, scopes: credential.scopes,
      issuedAt: credential.issuedAt, expiresAt: credential.expiresAt, revokedAt: credential.revokedAt,
      ...(credential.workspaceId === undefined ? {} : { workspaceId: credential.workspaceId }),
    }));
  } catch {
    return [];
  }
}

function readStdinLine(stdin) {
  return new Promise((resolve, reject) => {
    let text = '';
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => { text += chunk; });
    stdin.on('end', () => resolve(text.split(/\r?\n/)[0] ?? ''));
    stdin.on('error', reject);
  });
}

function askHidden(question, io) {
  return new Promise(resolve => {
    const prompt = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: true });
    prompt._writeToOutput = text => { if (text.includes(question)) io.stdout.write(question); };
    prompt.question(question, answer => {
      prompt.close();
      io.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readNewPassword(options, io, name) {
  let password;
  if (options.passwordStdin) password = await readStdinLine(io.stdin);
  else if (io.stdin.isTTY) {
    password = await askHidden('New password: ', io);
    if (await askHidden('Repeat the password: ', io) !== password) throw new CliError('The two passwords are not the same.');
  } else throw new CliError('Give the password with --password-stdin, or run this in a terminal to be asked for it.');
  checkPassword(password, name);
  return password;
}

function parse(argv) {
  const options = { positional: [], admin: false, hostAccess: false, passwordStdin: false, data: undefined, displayName: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--admin') options.admin = true;
    else if (argument === '--host-access') options.hostAccess = true;
    else if (argument === '--password-stdin') options.passwordStdin = true;
    else if (argument === '--data') options.data = argv[++index];
    else if (argument.startsWith('--data=')) options.data = argument.slice('--data='.length);
    else if (argument === '--display-name') options.displayName = argv[++index];
    else if (argument.startsWith('--')) throw new CliError(`Unknown option ${argument}.`);
    else options.positional.push(argument);
  }
  return options;
}

function findUser(accounts, rawName) {
  const name = String(rawName ?? '').trim().toLowerCase();
  const user = accounts.users.find(candidate => candidate.name === name);
  if (!user) throw new CliError(`No person is called "${name}". Run "users list" to see everyone.`);
  return user;
}

function newUser(name, displayName, passwordHash, role, hostAccess) {
  if (!USER_NAME_PATTERN.test(name)) throw new CliError('Use a sign-in name of lower-case letters, digits, dots, dashes or underscores.');
  return {
    id: `u_${randomBytes(12).toString('base64url')}`, name, displayName: (displayName ?? '').trim() || name, passwordHash,
    role, hostAccess: role === 'admin' || hostAccess, disabled: false, generation: 1, createdAt: Date.now(),
  };
}

const HELP = `Usage: users <list|init|on|off|add|disable|enable|reset-password|assign> [name] [options]
  init <name>               turn multi-user sign-in on with a first admin
  add <name> [--admin] [--host-access] [--display-name <text>]
  disable <name> | enable <name> | reset-password <name>
  assign <workspace> <name> | list | on | off
Options: --data <folder>, --password-stdin`;

/** Run one command. Returns the process exit code. */
export async function runAccountsCli(argv, { defaultDataDir = process.env.FLUJO_DATA_DIR?.trim() || process.cwd(), io = process } = {}) {
  const say = text => io.stdout.write(`${text}\n`);
  try {
    const options = parse(argv);
    const [command, ...rest] = options.positional;
    const dataDir = path.resolve(options.data ?? defaultDataDir);
    const files = paths(dataDir);
    if (!command || command === 'help' || command === '--help') { say(HELP); return command ? 0 : 1; }
    const { accounts, damaged } = await readAccounts(files);

    if (command === 'off') {
      if (damaged) {
        const aside = `${files.accounts}.damaged-${Date.now()}`;
        await fs.rename(files.accounts, aside).catch(() => undefined);
        await fs.rename(files.backup, `${aside}.bak`).catch(() => undefined);
        await saveAccounts(files, { schemaVersion: 1, enabled: false, revision: 0, users: [], teams: [], workspaces: {}, apiTokens: [] });
        say(`The damaged accounts file was moved to ${aside}. Multi-user sign-in is off; FLUJO is a single-user installation again.`);
      } else if (accounts?.enabled) {
        await saveAccounts(files, { ...accounts, enabled: false });
        say('Multi-user sign-in is off. Nothing was deleted; everyone is signed out.');
      } else say('Multi-user sign-in is already off.');
      await endSessions(files, () => false);
      await audit(files, 'mode-disabled', { type: 'installation', id: 'accounts' });
      return 0;
    }
    if (damaged) throw new CliError('The accounts file is damaged. Restore accounts.json, or run "users off" to start over.');

    if (command === 'list') {
      if (!accounts) { say('Multi-user sign-in has never been turned on here.'); return 0; }
      say(`Multi-user sign-in is ${accounts.enabled ? 'on' : 'off'}.`);
      for (const user of accounts.users) {
        say(`  ${user.name.padEnd(20)} ${user.role.padEnd(7)} ${user.disabled ? 'turned off' : 'active    '} ${user.role === 'admin' || user.hostAccess ? 'host access' : ''}`.trimEnd());
      }
      const byId = new Map(accounts.users.map(user => [user.id, user.name]));
      for (const workspace of await listWorkspaceNames(dataDir)) {
        const owner = accounts.workspaces[workspace];
        say(`  workspace ${workspace}: ${owner ? (byId.get(owner.ownerId) ?? owner.ownerId) : 'unassigned (admins only)'}`);
      }
      return 0;
    }

    if (command === 'init' || command === 'on') {
      if (accounts?.enabled) { say('Multi-user sign-in is already on.'); return 0; }
      if (accounts?.users.some(user => user.role === 'admin' && !user.disabled)) {
        await saveAccounts(files, { ...accounts, enabled: true });
        await audit(files, 'mode-enabled', { type: 'installation', id: 'accounts' });
        say('Multi-user sign-in is on again with the people from before.');
        return 0;
      }
      if (command === 'on') throw new CliError('There is no admin yet. Use "users init <name>" to create the first one.');
      const name = String(rest[0] ?? '').trim().toLowerCase();
      if (!name) throw new CliError('Say the first admin\'s sign-in name: users init <name>.');
      const admin = newUser(name, options.displayName, await hashPassword(await readNewPassword(options, io, name)), 'admin', true);
      const file = accounts ?? { schemaVersion: 1, enabled: true, revision: 0, users: [], teams: [], workspaces: {}, apiTokens: [] };
      if (file.users.some(user => user.name === name)) throw new CliError('That sign-in name is already taken.');
      file.enabled = true;
      file.users.push(admin);
      for (const workspace of await listWorkspaceNames(dataDir)) {
        file.workspaces[workspace] ??= { ownerType: 'user', ownerId: admin.id, assignedAt: Date.now() };
      }
      const known = new Set(file.apiTokens.flatMap(token => [token.id, token.digest]));
      for (const token of await ownerTokens(admin.id)) if (!known.has(token.id) && !known.has(token.digest)) file.apiTokens.push(token);
      await saveAccounts(files, file);
      await audit(files, 'user-added', { type: 'user', id: admin.id }, { role: 'admin' });
      await audit(files, 'mode-enabled', { type: 'installation', id: 'accounts' });
      say(`Multi-user sign-in is on. "${name}" is the first admin and owns every existing workspace.`);
      return 0;
    }

    if (!accounts) throw new CliError('Multi-user sign-in has never been turned on here. Start with "users init <name>".');

    if (command === 'add') {
      const name = String(rest[0] ?? '').trim().toLowerCase();
      if (accounts.users.some(user => user.name === name)) throw new CliError('That sign-in name is already taken.');
      const role = options.admin ? 'admin' : 'member';
      const user = newUser(name, options.displayName, await hashPassword(await readNewPassword(options, io, name)), role, options.hostAccess);
      await saveAccounts(files, { ...accounts, users: [...accounts.users, user] });
      await audit(files, 'user-added', { type: 'user', id: user.id }, { role });
      say(`Added "${name}" as ${role === 'admin' ? 'an admin' : 'a member'}.`);
      return 0;
    }
    if (command === 'disable' || command === 'enable') {
      const user = findUser(accounts, rest[0]);
      const disabled = command === 'disable';
      const users = accounts.users.map(candidate => candidate.id !== user.id ? candidate
        : { ...candidate, disabled, generation: candidate.generation + (disabled && !candidate.disabled ? 1 : 0) });
      await saveAccounts(files, { ...accounts, users });
      if (disabled) await endSessions(files, session => session.userId !== user.id);
      await audit(files, disabled ? 'user-disabled' : 'user-enabled', { type: 'user', id: user.id });
      say(`"${user.name}" is ${disabled ? 'turned off and signed out' : 'turned on again'}.`);
      return 0;
    }
    if (command === 'reset-password') {
      const user = findUser(accounts, rest[0]);
      const passwordHash = await hashPassword(await readNewPassword(options, io, user.name));
      const users = accounts.users.map(candidate => candidate.id !== user.id ? candidate
        : { ...candidate, passwordHash, generation: candidate.generation + 1 });
      await saveAccounts(files, { ...accounts, users });
      await endSessions(files, session => session.userId !== user.id);
      await audit(files, 'password-changed', { type: 'user', id: user.id });
      say(`"${user.name}" has a new password and was signed out everywhere.`);
      return 0;
    }
    if (command === 'assign') {
      const [workspace, owner] = rest;
      if (!WORKSPACE_NAME_PATTERN.test(String(workspace ?? '')) || !(await listWorkspaceNames(dataDir)).includes(workspace)) {
        throw new CliError(`There is no workspace "${workspace}".`);
      }
      const user = findUser(accounts, owner);
      await saveAccounts(files, {
        ...accounts, workspaces: { ...accounts.workspaces, [workspace]: { ownerType: 'user', ownerId: user.id, assignedAt: Date.now() } },
      });
      await audit(files, 'workspace-owner-changed', { type: 'workspace', id: workspace }, { ownerId: user.id });
      say(`Workspace "${workspace}" now belongs to "${user.name}".`);
      return 0;
    }
    throw new CliError(`Unknown command "${command}".\n${HELP}`);
  } catch (error) {
    io.stderr.write(`${error instanceof CliError ? error.message : `Could not change the accounts: ${error?.message ?? error}`}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runAccountsCli(process.argv.slice(2));
}

