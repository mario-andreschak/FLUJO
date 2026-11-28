// The same backup, restart, upgrade and restore checks for every shipped form.
// A target (targets.mjs) starts, stops and crashes one installed copy; a probe
// (flujo-probe.mjs) writes, reads, backs up and restores the test data.
import { delay } from './targets.mjs';
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
  'clean-stop': 'A normal stop ends the app and frees its port',
  ...MCP_CHECKS,
});

export const LIMITS = Object.freeze([
  'Test data only: one flow, one finished conversation, the theme and one non-secret setting. No model call, schedule or approval is checked.',
  'MCP checks run on the host forms: one local program server and one OAuth server from a local reference authorization server (official MCP SDK handlers). The container form starts local program servers only after the owner approves them, so it runs no MCP checks.',
  'A forced stop ends the processes; it is not a power cut. Data the operating system had not yet written to disk is not tested.',
  'On Windows a console program has no gentle stop signal, so a normal stop there also ends the process tree.',
  'Backups here are the ordinary selective backups (/api/backup), not complete data-folder or snapshot backups.',
]);

export function planChecks({ upgrade, mcp = false }) {
  return [upgrade ? 'previous-start' : 'start', 'seed-and-backup', ...(upgrade ? ['upgrade'] : []),
    'restart-after-stop', 'restart-after-crash', 'damaged-backup-refused', 'restore', 'backup-after-restore',
    ...(mcp ? Object.keys(MCP_CHECKS) : []), 'clean-stop'];
}

/** Wait until the target answers as itself and has finished starting up. */
export async function waitUntilReady(target, probe, { deadlineMs = 240_000, pause = delay } = {}) {
  const until = Date.now() + deadlineMs;
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
      break;
    }
    if (Date.now() >= until) {
      throw new Error(`${target.label} did not answer within ${Math.round(deadlineMs / 1000)} s.\n${await target.diagnostics()}`);
    }
    await pause(500);
  }
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
export async function runAcceptance({ candidate, previous, probe, mcp, readyOptions, log = () => {} }) {
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
  const start = async target => { await target.start(); await waitUntilReady(target, probe, readyOptions); };
  const stop = async (target, kind = 'stop') => {
    const record = kind === 'stop' ? await target.stop() : await target.kill();
    report.stops.push(record);
    return kind === 'stop' ? assertStopped(record) : record;
  };

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
      probe.assertSame(restored, original, { strict: !previous });
      return previous ? { backupFrom: 'previous release' } : undefined;
    });
    await check('backup-after-restore', async () => {
      const again = await probe.backup(candidate.request, restored);
      return { backupBytes: again.length };
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
