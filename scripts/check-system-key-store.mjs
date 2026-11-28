#!/usr/bin/env node
/**
 * Proves FLUJO's system key (#1443) against the real key store of this
 * computer, so nobody has to try it by hand on a Mac or a Linux desktop:
 *
 * - Windows: Windows data protection for this user.
 * - macOS: the login Keychain. Every entry the check makes is removed again.
 * - Linux: a throwaway GNOME keyring in a temporary folder, unlocked headless
 *   under its own D-Bus session; then that keyring locked; then a session with
 *   no keyring service; then no session at all, like Docker or a server.
 *
 * Each situation runs __tests__/encryption/systemKeyRealStore.test.ts with
 * FLUJO_TEST_REAL_SYSTEM_KEY naming it. CI runs this script in
 * .github/workflows/verify-full.yml.
 *
 * Usage: node scripts/check-system-key-store.mjs
 * Linux needs: sudo apt-get install -y gnome-keyring libsecret-tools dbus
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SUITE = '__tests__/encryption/systemKeyRealStore.test.ts';
export const LINUX_TOOLS = Object.freeze(['dbus-run-session', 'dbus-send', 'gnome-keyring-daemon', 'secret-tool']);
export const LINUX_PACKAGES = 'gnome-keyring libsecret-tools dbus';
/** Unlocks only the throwaway keyring this script makes in its own temporary folder. */
const THROWAWAY_KEYRING_PASSWORD = 'flujo-throwaway-keyring';
const SITUATION_TIMEOUT_MS = 15 * 60_000;
const JEST_ARGS = Object.freeze(['scripts/run-local-jest.cjs', '--ci', '--selectProjects', 'node', '--runInBand', '--runTestsByPath', SUITE]);

/** What this computer must show: one situation on Windows and macOS, four on Linux. */
export function situationsFor(platform) {
  if (platform === 'win32' || platform === 'darwin') return [{ scenario: 'working', session: 'desktop' }];
  if (platform === 'linux') {
    return [
      { scenario: 'working', session: 'keyring' },
      { scenario: 'locked', session: 'keyring' },
      { scenario: 'unavailable', session: 'bus-without-keyring' },
      { scenario: 'absent', session: 'none' },
    ];
  }
  throw new Error(`FLUJO offers no system key store on ${platform}.`);
}

/** A session bus that offers no services at all, so no keyring can start on it. */
export function busWithoutServices(socketDirectory) {
  return [
    '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
    '<busconfig>',
    '  <type>session</type>',
    `  <listen>unix:dir=${socketDirectory}</listen>`,
    '  <auth>EXTERNAL</auth>',
    '  <policy context="default">',
    '    <allow send_destination="*" eavesdrop="true"/>',
    '    <allow eavesdrop="true"/>',
    '    <allow own="*"/>',
    '  </policy>',
    '</busconfig>',
    '',
  ].join('\n');
}

/**
 * Linux runs keep the keyring, its sockets and its settings in `base`, and see
 * no display: a keyring prompt can never open on someone's screen.
 */
export function linuxEnvironment(env, base) {
  const child = {
    ...env,
    HOME: path.join(base, 'home'),
    XDG_RUNTIME_DIR: path.join(base, 'run'),
    XDG_DATA_HOME: path.join(base, 'home', '.local', 'share'),
    XDG_CONFIG_HOME: path.join(base, 'home', '.config'),
    XDG_CACHE_HOME: path.join(base, 'home', '.cache'),
  };
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'GNOME_KEYRING_CONTROL', 'SSH_AUTH_SOCK']) delete child[name];
  return child;
}

/** The command that runs one situation, as `[file, ...args]`. */
export function commandFor(situation, { node = process.execPath, busConfig } = {}) {
  const jest = [node, ...JEST_ARGS];
  if (situation.session === 'keyring') {
    return ['dbus-run-session', '--', 'sh', '-c',
      'printf %s "$0" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && exec "$@"',
      THROWAWAY_KEYRING_PASSWORD, ...jest];
  }
  if (situation.session === 'bus-without-keyring') {
    if (!busConfig) throw new Error('A bus without services needs its configuration file.');
    return ['dbus-run-session', `--config-file=${busConfig}`, '--', ...jest];
  }
  return jest;
}

/** Linux tools from LINUX_TOOLS that are not on `searchPath`. */
export async function missingLinuxTools(searchPath = process.env.PATH ?? '') {
  const directories = searchPath.split(path.delimiter).filter(Boolean);
  const missing = [];
  for (const tool of LINUX_TOOLS) {
    let found = false;
    for (const directory of directories) {
      try { await access(path.join(directory, tool), constants.X_OK); found = true; break; }
      catch { /* not in this directory */ }
    }
    if (!found) missing.push(tool);
  }
  return missing;
}

function run([file, ...args], env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), SITUATION_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 1, error }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, signal }); });
  });
}

async function runSituation(situation) {
  const env = { ...process.env, FLUJO_TEST_REAL_SYSTEM_KEY: situation.scenario };
  if (situation.session === 'desktop') return run(commandFor(situation), env);
  const base = await mkdtemp(path.join(os.tmpdir(), 'flujo-keyring-check-'));
  try {
    const childEnv = linuxEnvironment(env, base);
    await mkdir(childEnv.HOME, { recursive: true });
    await mkdir(childEnv.XDG_RUNTIME_DIR, { recursive: true });
    await chmod(childEnv.XDG_RUNTIME_DIR, 0o700);
    let busConfig;
    if (situation.session === 'bus-without-keyring') {
      busConfig = path.join(base, 'session-bus.conf');
      await writeFile(busConfig, busWithoutServices(childEnv.XDG_RUNTIME_DIR));
    }
    return await run(commandFor(situation, { busConfig }), childEnv);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

export async function main(platform = process.platform) {
  if (platform === 'linux') {
    const missing = await missingLinuxTools();
    if (missing.length) {
      throw new Error(`Missing ${missing.join(', ')}. Install them with: sudo apt-get install -y ${LINUX_PACKAGES}`);
    }
  }
  const results = [];
  for (const situation of situationsFor(platform)) {
    console.log(`\n== System key store: ${situation.scenario} (${situation.session}) ==`);
    const result = await runSituation(situation);
    results.push({ ...situation, ...result });
  }
  console.log('\nSystem key store results:');
  for (const result of results) {
    console.log(`  ${result.code === 0 ? 'passed' : 'FAILED'}  ${result.scenario} (${result.session})${result.error ? `: ${result.error.message}` : ''}`);
  }
  return results.every(result => result.code === 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((passed) => { process.exitCode = passed ? 0 : 1; }, (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
