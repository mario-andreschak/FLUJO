// The same backup, restart, upgrade, disk-full, schedule, MCP and restore checks
// for every shipped form. A target (targets.mjs) starts, stops and crashes one
// installed copy; a probe (flujo-probe.mjs) writes, reads, backs up and
// restores the test data; the volume (low-disk.mjs) holds the data folder and
// can be filled; the stand-ins (stand-ins.mjs) play model and tool; the MCP
// checks (mcp-checks.mjs) use local reference servers on host forms.
import { delay, waitFor } from './targets.mjs';
import { MCP_CHECKS } from './mcp-checks.mjs';

export const CHECKS = Object.freeze({
  'previous-start': 'The previous release starts on an empty data folder',
  start: 'The release under test starts on an empty data folder',
  'seed-and-backup': 'A backup taken right after adding test data holds exactly that data',
  upgrade: 'The release under test opens the data folder of the previous release and shows the same data',
  'restart-after-stop': 'Data is unchanged after a normal stop and start',
  'restart-after-crash': 'Changes saved right before a forced stop are still there after the restart',
  'damaged-backup-refused': 'Damaged backups are refused and change nothing',
  restore: 'Restoring the backup brings the original data back',
  'backup-after-restore': 'A new backup after the restore holds exactly the restored data',
  'kill-during-backup': 'A forced stop in the middle of a backup changes nothing, and the next backups are complete',
  'disk-full': 'With a full disk the app keeps running and loses nothing, and works again once space is freed',
  'schedules-and-approvals': 'Schedules and waiting approvals survive a forced restart; nothing runs twice or without approval',
  'clean-stop': 'A normal stop ends the app and frees its port',
  ...MCP_CHECKS,
});

export const LIMITS = Object.freeze([
  'Test data: one flow, one finished conversation, the theme and one non-secret setting; for schedules and approvals a stand-in model and a stand-in MCP tool on this machine. No real provider, account or secret is used.',
  'MCP checks run on the host forms: one local program server and one OAuth server from a local reference authorization server (official MCP SDK handlers). The container form starts local program servers only after the owner approves them, so it runs no MCP checks.',
  'A forced stop ends the processes; it is not a power cut. Data the operating system had not yet written to disk is not tested.',
  'On Windows a console program has no gentle stop signal, so a normal stop there also ends the process tree.',
  'Backups are the ordinary selective backups (/api/backup) and, on host installations, snapshot backups (/api/snapshot). Copies of the whole data folder are made by the operator, not by the app, and are not covered.',
  'The data folder lives on its own small volume, which the disk-full check fills to the last byte; the system disk is never filled.',
  'A container accepts snapshot backups only from inside itself, so in a container the forced stop hits an ordinary backup only.',
]);

export const DEFAULT_TIMING = Object.freeze({ readyMs: 240_000, recoveryMs: 60_000, scheduleMs: 120_000, pause: delay });

/** The MCP checks come after every data check: they add servers and turn on encryption, which the data checks never expect. */
export function planChecks({ upgrade, mcp = false }) {
  return [upgrade ? 'previous-start' : 'start', 'seed-and-backup', ...(upgrade ? ['upgrade'] : []),
    'restart-after-stop', 'restart-after-crash', 'damaged-backup-refused', 'restore', 'backup-after-restore',
    'kill-during-backup', 'disk-full', 'schedules-and-approvals', ...(mcp ? Object.keys(MCP_CHECKS) : []), 'clean-stop'];
}

/** Errors worth another try while an app recovers: no answer, a server error or a timeout. Never a 4xx. */
export function isTransient(error) {
  if (Number.isInteger(error?.status)) return error.status === 0 || error.status >= 500;
  return error?.name === 'TimeoutError' || (error instanceof TypeError && /fetch failed/i.test(error.message));
}

/** Repeat `operation` while it fails with a transient error, up to `deadlineMs`. */
export async function untilRecovered(operation, { deadlineMs, intervalMs = 2_000, pause = delay }) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try { return await operation(); } catch (error) {
      if (!isTransient(error) || Date.now() >= until) throw error;
      await pause(intervalMs);
    }
  }
}

/** Wait until the target answers as itself, without asking it to do anything else. */
export async function waitForIdentity(target, { readyMs, pause }) {
  const until = Date.now() + readyMs;
  for (;;) {
    if (!(await target.running())) {
      throw new Error(`${target.label} stopped before it was ready.\n${await target.diagnostics()}`);
    }
    let identity;
    try {
      const response = await target.request('/api/cwd', { timeoutMs: 10_000 });
      if (response.status === 200) identity = JSON.parse(response.bytes);
    } catch { identity = undefined; }
    if (identity) {
      target.assertIdentity(identity);
      return;
    }
    if (Date.now() >= until) {
      throw new Error(`${target.label} did not answer within ${Math.round(readyMs / 1000)} s.\n${await target.diagnostics()}`);
    }
    await pause(500);
  }
}

/** Wait until the target answers as itself and has finished starting up. */
export async function waitUntilReady(target, probe, timing) {
  await waitForIdentity(target, timing);
  await probe.ready(target.request);
}

function assertStopped(record) {
  if (record.graceful === false) throw new Error(`${record.target} did not stop on its own after a normal stop request (${record.mode}).`);
  if (!record.portClosed) throw new Error(`${record.target} still answers on its port after it stopped.`);
  return record;
}

/**
 * Run every check in order. A failed check stops the run; later checks are
 * reported as not run. Every started copy is stopped before this returns.
 */
export async function runAcceptance({ candidate, previous, probe, volume, standIns, mcp, timing: overrides, log = () => {} }) {
  const timing = { ...DEFAULT_TIMING, ...overrides };
  const plan = planChecks({ upgrade: Boolean(previous), mcp: Boolean(mcp) });
  const report = {
    checks: plan.map(id => ({ id, title: CHECKS[id], result: 'not-run' })),
    stops: [], limits: [...LIMITS], result: 'failed',
  };
  const check = async (id, operation) => {
    const entry = report.checks.find(item => item.id === id);
    const started = Date.now();
    try {
      const details = await operation();
      if (details) entry.details = details;
      entry.result = 'passed';
    } catch (error) {
      entry.result = 'failed';
      entry.error = error.message;
      throw error;
    } finally {
      entry.seconds = Math.round((Date.now() - started) / 100) / 10;
      log(entry);
    }
  };
  const start = async target => { await target.start(); await waitUntilReady(target, probe, timing); };
  const stop = async (target, kind = 'stop') => {
    const record = kind === 'stop' ? await target.stop() : await target.kill();
    report.stops.push(record);
    return kind === 'stop' ? assertStopped(record) : record;
  };
  const backupAccess = () => ({ snapshotToken: candidate.snapshotToken });

  let original; let backup; let current; let restored;
  try {
    const writer = previous ?? candidate;
    await check(previous ? 'previous-start' : 'start', () => start(writer));
    await check('seed-and-backup', async () => {
      original = await probe.seed(writer.request);
      backup = await probe.backup(writer.request, original);
      current = original;
      return { backupBytes: backup.length };
    });
    if (previous) {
      await check('upgrade', async () => {
        await stop(previous);
        await previous.remove?.();
        await start(candidate);
        current = await probe.observe(candidate.request);
        probe.assertSame(current, original, { strict: false });
      });
    }
    await check('restart-after-stop', async () => {
      await stop(candidate);
      await start(candidate);
      probe.assertSame(await probe.observe(candidate.request), current, { strict: true });
    });
    await check('restart-after-crash', async () => {
      const changed = await probe.change(candidate.request, current);
      await stop(candidate, 'kill');
      await start(candidate);
      probe.assertSame(await probe.observe(candidate.request), changed, { strict: true });
      current = changed;
    });
    await check('damaged-backup-refused', async () => {
      const refused = [];
      for (const damaged of await probe.damagedBackups(backup)) {
        const status = await probe.restore(candidate.request, damaged.bytes);
        if (status !== 400) throw new Error(`The damaged backup ${damaged.name} was answered with ${status}, not refused with 400.`);
        probe.assertSame(await probe.observe(candidate.request), current, { strict: true });
        refused.push(damaged.name);
      }
      return { refused };
    });
    await check('restore', async () => {
      const status = await probe.restore(candidate.request, backup);
      if (status !== 200) throw new Error(`Restoring the backup answered ${status}.`);
      restored = await probe.observe(candidate.request);
      probe.assertSame(restored, probe.expectedAfterRestore(original, current), { strict: !previous });
      current = restored;
      return previous ? { backupFrom: 'previous release' } : undefined;
    });
    await check('backup-after-restore', async () => {
      const again = await probe.backup(candidate.request, restored);
      return { backupBytes: again.length };
    });
    await check('kill-during-backup', async () => {
      const underway = await probe.startBackups(candidate.request, backupAccess());
      let interrupted;
      try { await stop(candidate, 'kill'); } finally { interrupted = underway.settle(); }
      await start(candidate);
      probe.assertSame(await probe.observe(candidate.request), current, { strict: true });
      const completed = await probe.completeBackups(candidate.request, backupAccess(), current);
      current = await probe.change(candidate.request, current, { variant: 'Changed after a stop during a backup' });
      return { interrupted, ...completed };
    });
    await check('disk-full', async () => {
      const filled = await volume.fill();
      let attempt;
      try {
        attempt = await probe.attemptChange(candidate.request, current, 'Changed while the disk was full');
        if (!(await candidate.running())) throw new Error(`${candidate.label} stopped when the disk was full.\n${await candidate.diagnostics()}`);
        const alive = await candidate.request('/api/cwd', { timeoutMs: 30_000 }).catch(() => ({ status: 0 }));
        if (alive.status !== 200) throw new Error(`${candidate.label} stopped answering when the disk was full (answer: ${alive.status || 'none'}).`);
      } finally {
        await volume.free();
      }
      const recovery = { deadlineMs: timing.recoveryMs, pause: timing.pause };
      const shown = await untilRecovered(() => probe.observe(candidate.request), recovery);
      const outcome = probe.assertChangeOutcome(shown, current, attempt);
      const items = outcome.refused.length ? outcome.refused : ['setting'];
      const recovered = await untilRecovered(() => probe.change(candidate.request, shown, { variant: 'Changed after the disk was freed', items }), recovery);
      await stop(candidate, 'kill');
      await start(candidate);
      probe.assertSame(await probe.observe(candidate.request), recovered, { strict: true });
      current = recovered;
      return { volume: volume.description, fillerBytes: filled.fillerBytes, ...outcome };
    });
    await check('schedules-and-approvals', async () => {
      const automation = await probe.prepareAutomation(candidate.request, standIns);
      const killedAt = Date.now();
      await stop(candidate, 'kill');
      await candidate.start();
      const restartedAt = Date.now();
      await waitForIdentity(candidate, timing);
      await waitFor(() => standIns.requestsFor('schedule').some(item => item.at >= restartedAt), {
        deadlineMs: timing.scheduleMs, pause: timing.pause,
        message: `The schedule did not run within ${Math.round(timing.scheduleMs / 1000)} s of a restart that nobody followed by opening the app.`,
      });
      await probe.ready(candidate.request);
      const details = await probe.verifyAutomation(candidate.request, automation, standIns, { killedAt, restartedAt });
      if (standIns.failures.length) throw new Error(`The stand-ins received requests they could not read: ${standIns.failures.join('; ')}`);
      return details;
    });
    if (mcp) {
      await check('mcp-stdio', () => mcp.stdio(candidate.request));
      await check('mcp-oauth', () => mcp.oauth(candidate.request, `http://127.0.0.1:${candidate.port}`));
      await check('mcp-oauth-after-restart', () => mcp.oauthAfterRestart(candidate.request, async () => {
        await stop(candidate);
        await start(candidate);
      }));
    }
    await check('clean-stop', () => stop(candidate).then(() => undefined));
    report.result = 'passed';
  } catch (error) {
    report.failure = error.message;
    report.diagnostics = {};
    for (const target of [candidate, previous].filter(Boolean)) {
      try { report.diagnostics[target.label] = await target.diagnostics(); } catch { report.diagnostics[target.label] = ''; }
    }
  } finally {
    report.cleanup = [];
    for (const target of [candidate, previous].filter(Boolean)) {
      try { await target.dispose(); } catch (error) {
        report.cleanup.push(`${target.label}: ${error.message}`);
        report.result = 'failed';
      }
    }
  }
  return report;
}
