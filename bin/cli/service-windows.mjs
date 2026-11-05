/**
 * Autostart on Windows through Task Scheduler, not a Windows service. A service
 * would need its own wrapper program, usually runs as SYSTEM, and needs
 * administrator rights just to install. A task runs as an ordinary named user.
 *
 * Three start modes, from best to least good:
 *
 *   boot   Starts when the PC starts, with nobody logged in. Needs administrator
 *          rights to set up, once. Stores no password. Windows cannot unlock that
 *          user's own protected data in this mode (see unattended-unlock docs).
 *   logon  Starts when that user logs on.
 *   timer  Tried when "logon" is refused. Checks every few minutes, and only runs
 *          while that user is logged on. Needs no special rights.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError, runProgram, windowsSystemProgram } from './common.mjs';

export const taskNameFor = name => `FLUJO-${name}`;
/** Starts the task again if the supervisor itself has died. */
const WATCHDOG_INTERVAL = 'PT5M';

const xmlEscape = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

const quoteArgument = value => `"${value}"`;

export function localTimestamp(now = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function triggerXml(mode, userId, now) {
  const repetition = `<Repetition><Interval>${WATCHDOG_INTERVAL}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`;
  if (mode === 'boot') return `<BootTrigger>${repetition}<Enabled>true</Enabled></BootTrigger>`;
  const timer = `<TimeTrigger>${repetition}<StartBoundary>${localTimestamp(now)}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`;
  if (mode === 'timer') return timer;
  return `<LogonTrigger>${repetition}<Enabled>true</Enabled><UserId>${xmlEscape(userId)}</UserId></LogonTrigger>`;
}

/**
 * The logon and timer modes run in the user's desktop session, where a console
 * program would open a window. conhost --headless runs it with none. boot mode
 * has no desktop, so it does not need this.
 */
export function taskAction(mode, { nodePath, launcher, serviceArgs }) {
  const args = [launcher, ...serviceArgs].map(quoteArgument).join(' ');
  if (mode === 'boot') return { command: nodePath, args };
  return { command: windowsSystemProgram('conhost.exe'), args: `--headless ${quoteArgument(nodePath)} ${args}` };
}

export function taskXml({ name, mode, userId, nodePath, launcher, serviceArgs, workingDirectory, now = new Date() }) {
  const action = taskAction(mode, { nodePath, launcher, serviceArgs });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`Keeps the FLUJO instance "${name}" running. Remove it with: flujo service uninstall --name ${name}`)}</Description>
  </RegistrationInfo>
  <Triggers>${triggerXml(mode, userId, now)}</Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>${mode === 'boot' ? 'S4U' : 'InteractiveToken'}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(action.args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export const MODE_EXPLANATIONS = {
  boot: 'Starts when the PC starts, with nobody logged in. It runs as your user but without your password, so Windows gives it no access to network shares or to data protected for your user alone.',
  logon: 'Starts when you log on. To start with nobody logged in, run this command once as administrator, in a window opened with "Run as administrator".',
  timer: 'Checks every 5 minutes and only runs while you are logged on. Windows refused a logon start for this account. To start with nobody logged in, run this command once as administrator.',
};

function currentUserSid(run) {
  const result = run(windowsSystemProgram('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = result.stdout.match(/S-1-[0-9-]+/)?.[0];
  if (!result.ok || !sid) throw new CliError('Windows did not report the current user, so the autostart entry could not be set up.');
  return sid;
}

/** Write the definition as UTF-16 with a byte order mark, which schtasks requires. */
function registerTask({ taskName, xml, directory, run }) {
  const file = path.join(directory, `.task-${randomUUID()}.xml`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  try {
    return run(windowsSystemProgram('schtasks.exe'), ['/Create', '/TN', taskName, '/XML', file, '/F']);
  } finally { fs.rmSync(file, { force: true }); }
}

/**
 * auto: boot if Windows allows it, then logon, then timer. Asking for one mode
 * by name fails if that mode is refused, because then a silent lesser mode would
 * be a surprise.
 */
export function installWindowsTask({ name, requestedMode, nodePath, launcher, serviceArgs, workingDirectory, run = runProgram }) {
  const taskName = taskNameFor(name);
  const userId = currentUserSid(run);
  const attempts = requestedMode === 'auto' ? ['boot', 'logon', 'timer'] : [requestedMode];
  const refused = [];
  for (const mode of attempts) {
    const xml = taskXml({ name, mode, userId, nodePath, launcher, serviceArgs, workingDirectory });
    const result = registerTask({ taskName, xml, directory: workingDirectory, run });
    if (result.ok) return { taskName, mode, explanation: MODE_EXPLANATIONS[mode], refused };
    refused.push(mode);
  }
  throw new CliError(requestedMode === 'boot'
    ? 'Windows refused the start at boot. This needs administrator rights once: open a window with "Run as administrator" and run this command again.'
    : `Windows refused the autostart entry (tried: ${attempts.join(', ')}).`);
}

export function startWindowsTask(name, { run = runProgram } = {}) {
  return run(windowsSystemProgram('schtasks.exe'), ['/Run', '/TN', taskNameFor(name)]).ok;
}

export function endWindowsTask(name, { run = runProgram } = {}) {
  return run(windowsSystemProgram('schtasks.exe'), ['/End', '/TN', taskNameFor(name)]).ok;
}

export function removeWindowsTask(name, { run = runProgram } = {}) {
  return run(windowsSystemProgram('schtasks.exe'), ['/Delete', '/TN', taskNameFor(name), '/F']).ok;
}

/** Read through PowerShell: schtasks prints its fields in the language of the PC. */
export function windowsTaskStatus(name, { run = runProgram } = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$task = Get-ScheduledTask -TaskName '${taskNameFor(name)}'`,
    '$info = $task | Get-ScheduledTaskInfo',
    '[Console]::Out.Write((@{ state = [string]$task.State; logonType = [string]$task.Principal.LogonType; lastResult = $info.LastTaskResult; triggers = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) } | ConvertTo-Json -Compress))',
  ].join('; ');
  const result = run(windowsSystemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60_000 });
  if (!result.ok) return { installed: false };
  try { return { installed: true, ...JSON.parse(result.stdout) }; }
  catch { return { installed: true }; }
}
