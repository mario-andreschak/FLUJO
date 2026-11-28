import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LINUX_TOOLS, SUITE, busWithoutServices, commandFor, linuxEnvironment, missingLinuxTools, situationsFor,
} from './check-system-key-store.mjs';

test('every system proves a working store, and Linux also proves locked, missing-service and no-session fallbacks', () => {
  assert.deepEqual(situationsFor('win32'), [{ scenario: 'working', session: 'desktop' }]);
  assert.deepEqual(situationsFor('darwin'), [{ scenario: 'working', session: 'desktop' }]);
  assert.deepEqual(situationsFor('linux').map(situation => situation.scenario), ['working', 'locked', 'unavailable', 'absent']);
  assert.throws(() => situationsFor('freebsd'), /no system key store on freebsd/);
});

test('Linux runs keep the keyring in the throwaway folder and can never open a prompt on a screen', () => {
  const base = path.join(os.tmpdir(), 'flujo-keyring-check-test');
  const env = linuxEnvironment({
    PATH: '/usr/bin', HOME: '/home/someone', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', GNOME_KEYRING_CONTROL: '/run/user/1000/keyring', SSH_AUTH_SOCK: '/tmp/agent',
    FLUJO_TEST_REAL_SYSTEM_KEY: 'working',
  }, base);
  for (const name of ['HOME', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(env[name].startsWith(base), `${name} must stay inside the throwaway folder`);
  }
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL', 'SSH_AUTH_SOCK']) {
    assert.equal(env[name], undefined, `${name} must not reach the check`);
  }
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FLUJO_TEST_REAL_SYSTEM_KEY, 'working');
});

test('each situation runs the whole real-store suite in the session it needs', () => {
  const [working, locked, unavailable, absent] = situationsFor('linux');
  const jest = ['/node', 'scripts/run-local-jest.cjs', '--ci', '--selectProjects', 'node', '--runInBand', '--runTestsByPath', SUITE];
  for (const keyring of [working, locked]) {
    const command = commandFor(keyring, { node: '/node' });
    assert.deepEqual(command.slice(0, 4), ['dbus-run-session', '--', 'sh', '-c']);
    assert.match(command[4], /gnome-keyring-daemon --unlock --components=secrets >\/dev\/null && exec "\$@"$/);
    assert.deepEqual(command.slice(6), jest);
  }
  assert.deepEqual(commandFor(unavailable, { node: '/node', busConfig: '/tmp/bus.conf' }),
    ['dbus-run-session', '--config-file=/tmp/bus.conf', '--', ...jest]);
  assert.throws(() => commandFor(unavailable, { node: '/node' }), /configuration file/);
  assert.deepEqual(commandFor(absent, { node: '/node' }), jest);
  assert.deepEqual(commandFor(situationsFor('darwin')[0], { node: '/node' }), jest);
});

test('the bus without a keyring offers no services that could start one', () => {
  const config = busWithoutServices('/tmp/flujo-run');
  assert.match(config, /<type>session<\/type>/);
  assert.match(config, /<listen>unix:dir=\/tmp\/flujo-run<\/listen>/);
  assert.doesNotMatch(config, /servicedir|standard_session_servicedirs|<include/);
});

test('missing Linux tools are named instead of silently skipping the check', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flujo-keyring-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await missingLinuxTools(directory), [...LINUX_TOOLS]);
  if (process.platform === 'win32') return;
  for (const tool of LINUX_TOOLS.slice(0, 2)) {
    await writeFile(path.join(directory, tool), '#!/bin/sh\n');
    await chmod(path.join(directory, tool), 0o755);
  }
  assert.deepEqual(await missingLinuxTools(directory), LINUX_TOOLS.slice(2));
});
