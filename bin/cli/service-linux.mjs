/**
 * Autostart on Linux through systemd. As an ordinary user this writes a user unit
 * and turns on "lingering", which starts it at boot with nobody logged in. As root
 * it writes a system unit, and insists on naming the account to run as, so FLUJO
 * never runs as root by accident.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, runProgram } from './common.mjs';

export const unitNameFor = name => `flujo-${name}.service`;

/** systemd treats % as a placeholder and splits on spaces unless quoted. */
const systemdQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export function systemdUnit({ name, nodePath, launcher, serviceArgs, workingDirectory, system = false, runAs }) {
  const command = [nodePath, launcher, ...serviceArgs].map(systemdQuote).join(' ');
  return `[Unit]
Description=FLUJO instance ${name}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${systemdQuote(workingDirectory)}
Restart=always
RestartSec=5
# The supervisor stops FLUJO itself, then systemd cleans up anything left.
KillMode=mixed
TimeoutStopSec=40
NoNewPrivileges=yes
${system ? `User=${runAs}\n` : ''}
[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`;
}

export function unitPath(name, { system, homedir = os.homedir() }) {
  return system
    ? path.join('/etc/systemd/system', unitNameFor(name))
    : path.join(homedir, '.config', 'systemd', 'user', unitNameFor(name));
}

const scopeArgs = system => (system ? [] : ['--user']);

export function installSystemdUnit({
  name, nodePath, launcher, serviceArgs, workingDirectory, runAs, enable = true,
  run = runProgram, isRoot = process.getuid?.() === 0, homedir = os.homedir(), username = os.userInfo().username,
}) {
  const system = isRoot;
  if (system && !runAs) throw new CliError('When running as root, name the account for FLUJO with --run-as <user>. FLUJO does not run as root.');
  if (system && runAs === 'root') throw new CliError('FLUJO does not run as root. Name another account with --run-as <user>.');
  if (runAs && !/^[a-z_][a-z0-9_-]*[$]?$/i.test(runAs)) throw new CliError('The account name given to --run-as is not valid.');
  const file = unitPath(name, { system, homedir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit({ name, nodePath, launcher, serviceArgs, workingDirectory, system, runAs }), { mode: 0o644 });
  const notes = [];
  let mode = 'boot';
  let explanation = system
    ? 'Starts when the machine starts, with nobody logged in.'
    : 'Starts when the machine starts, with nobody logged in, using systemd lingering for this user.';
  if (!enable) return { unitFile: file, mode, enabled: false, explanation, notes };
  const scope = scopeArgs(system);
  const reload = run('systemctl', [...scope, 'daemon-reload']);
  if (!reload.ok) {
    notes.push('systemctl could not be reached, so the unit was written but not switched on.');
    return { unitFile: file, mode: 'none', enabled: false, explanation: 'Not active yet: systemd did not answer.', notes };
  }
  if (!system && !run('loginctl', ['enable-linger', username]).ok) {
    mode = 'logon';
    explanation = 'Starts when this user logs in. To start at boot with nobody logged in, an administrator can run: loginctl enable-linger ' + username;
    notes.push('Lingering could not be turned on.');
  }
  const enabled = run('systemctl', [...scope, 'enable', unitNameFor(name)]).ok;
  if (!enabled) notes.push('The unit could not be enabled.');
  return { unitFile: file, mode, enabled, explanation, notes };
}

export function startSystemdUnit(name, { system = process.getuid?.() === 0, run = runProgram } = {}) {
  return run('systemctl', [...scopeArgs(system), 'start', unitNameFor(name)]).ok;
}

export function stopSystemdUnit(name, { system = process.getuid?.() === 0, run = runProgram } = {}) {
  return run('systemctl', [...scopeArgs(system), 'stop', unitNameFor(name)], { timeout: 60_000 }).ok;
}

export function removeSystemdUnit(name, { system = process.getuid?.() === 0, run = runProgram, homedir = os.homedir() } = {}) {
  const scope = scopeArgs(system);
  run('systemctl', [...scope, 'disable', '--now', unitNameFor(name)], { timeout: 60_000 });
  fs.rmSync(unitPath(name, { system, homedir }), { force: true });
  run('systemctl', [...scope, 'daemon-reload']);
  return true;
}

export function systemdStatus(name, { system = process.getuid?.() === 0, run = runProgram, homedir = os.homedir() } = {}) {
  if (!fs.existsSync(unitPath(name, { system, homedir }))) return { installed: false };
  const scope = scopeArgs(system);
  return {
    installed: true,
    state: run('systemctl', [...scope, 'is-active', unitNameFor(name)]).stdout.trim() || 'unknown',
    enabled: run('systemctl', [...scope, 'is-enabled', unitNameFor(name)]).stdout.trim() || 'unknown',
  };
}
