import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNoRefusal, findServerConfig, holdFile, qualifyUnderLocks, retryTraces, runWhileHeld } from './smoke-file-locks.mjs';
import { probeResourceListing } from './smoke-mcp-artifacts.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'Mandatory file locks exist only on Windows.' };

function fakeLogs() {
  const chunks = [];
  return { chunks, push: (text) => chunks.push(text), mark: () => chunks.length, since: (mark) => chunks.slice(mark).join('') };
}

/** Stands in for a lock: records whether it is held, so a fake app can wait for the release. */
function fakeHold() {
  const state = { held: 0, released: 0 };
  const hold = async () => { state.held += 1; return { release: async () => { state.released += 1; } }; };
  return { state, hold, isHeld: () => state.held > state.released };
}

const until = async (condition) => { while (!condition()) await new Promise((resolve) => setTimeout(resolve, 2)); };

async function withDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-smoke-locks-'));
  try { await operation(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('reads retry lines by label and code, across chunk boundaries', () => {
  const text = 'noise\n[transient-file-retry] owner-policy EBUSY after try 1, waiting 50 ms\n'
    + '[transient-file-retry] private-approval other after try 2, waiting 150 ms\r\n[private-approval-set-reader] retry {}';
  assert.deepEqual(retryTraces(text), [{ label: 'owner-policy', code: 'EBUSY' }, { label: 'private-approval', code: 'other' }]);
  assert.deepEqual(retryTraces(['[transient-file-retry] storage-rep', 'lace EPERM after try 1, waiting 5 ms'].join('')),
    [{ label: 'storage-replace', code: 'EPERM' }]);
});

test('any refusal on the resource path fails the run with the refusing lines', () => {
  assert.doesNotThrow(() => assertNoRefusal('[workload-guard] config-first settled 3\nPrivate approval check passed after 2 tries in 60 ms.', 'listing'));
  for (const line of ['FLUJO refused a private approval check while reading the file for the private ledger file: EBUSY',
    '[private-approval-set-reader] refused { phase: \'contents\' }', '[workload-guard] refused private-files']) {
    assert.throws(() => assertNoRefusal(`ok\n${line}\n`, 'listing'), (error) => error.message.includes(line) && error.message.includes('during listing'));
  }
});

test('lets go of the file as soon as the app reports a retry, so the app can finish', async () => {
  const logs = fakeLogs();
  const { state, hold, isHeld } = fakeHold();
  const outcome = await runWhileHeld({ file: 'owner.json', kind: 'exclusive', labels: ['owner-policy'], logs, hold, operation: async () => {
    assert.equal(isHeld(), true);
    logs.push('[transient-file-retry] owner-policy EBUSY after try 1, waiting 50 ms\n');
    await until(() => !isHeld());
    return 'listed';
  } });
  assert.equal(outcome.result, 'listed');
  assert.deepEqual(outcome.met, [{ label: 'owner-policy', code: 'EBUSY' }]);
  assert.deepEqual(state, { held: 1, released: 1 });
});

test('a refusal from the app fails the run, and the file is released first', async () => {
  const logs = fakeLogs();
  const { state, hold } = fakeHold();
  await assert.rejects(runWhileHeld({ file: 'approval.json', kind: 'exclusive', labels: ['private-approval'], logs, hold,
    operation: async () => { throw new Error('HOST_CONSENT_REQUIRED'); } }), /HOST_CONSENT_REQUIRED/);
  assert.deepEqual(state, { held: 1, released: 1 });
});

test('another reader meeting the lock releases it but does not count as meeting it', async () => {
  const logs = fakeLogs();
  const { hold, isHeld } = fakeHold();
  const outcome = await runWhileHeld({ file: 'mcp_servers.json', kind: 'exclusive', labels: ['workload-config'], logs, hold, operation: async () => {
    logs.push('[transient-file-retry] storage-read EBUSY after try 1, waiting 50 ms\n');
    await until(() => !isHeld());
  } });
  assert.deepEqual(outcome.met, []);
});

test('an unrelated rename conflict elsewhere does not release an exclusive lock early', async () => {
  const logs = fakeLogs();
  const { hold, isHeld } = fakeHold();
  let heldAfterRename = false;
  const outcome = await runWhileHeld({ file: 'owner.json', kind: 'exclusive', labels: ['owner-policy'], logs, hold, operation: async () => {
    logs.push('[transient-file-retry] storage-replace EPERM after try 1, waiting 5 ms\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    heldAfterRename = isHeld();
    logs.push('[transient-file-retry] owner-policy EBUSY after try 1, waiting 50 ms\n');
    await until(() => !isHeld());
  } });
  assert.equal(heldAfterRename, true);
  assert.deepEqual(outcome.met, [{ label: 'owner-policy', code: 'EBUSY' }]);
});

test('tries a target again until the app meets its lock, and fails a target that is never met', async () => {
  const logs = fakeLogs();
  const { state, hold, isHeld } = fakeHold();
  let calls = 0;
  const lines = [];
  const report = await qualifyUnderLocks([{ name: 'resource listing', file: 'approval.json', kind: 'exclusive', labels: ['private-approval'],
    operation: async () => {
      if (++calls < 2) return;
      logs.push('[transient-file-retry] private-approval EBUSY after try 1, waiting 50 ms\n');
      await until(() => !isHeld());
    } }], { logs, hold, log: (line) => lines.push(line) });
  assert.equal(calls, 2);
  assert.equal(state.released, 2);
  assert.match(report[0], /resource listing: met the exclusive lock on approval\.json \(private-approval EBUSY\)/);
  assert.deepEqual(lines, report);

  await assert.rejects(qualifyUnderLocks([{ name: 'host approval', file: 'approval.json', kind: 'reader', labels: ['approval-ledger-replace'],
    operation: async () => {} }], { logs, hold, tries: 2, log: () => {} }), /No approval-ledger-replace step met the reader lock on approval\.json during host approval/);
});

test('finds the one stored server config of the smoke profile', async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(findServerConfig(directory), /ENOENT/);
    const db = path.join(directory, 'workspaces', 'default-workspace', 'db');
    await fs.mkdir(db, { recursive: true });
    await fs.mkdir(path.join(directory, 'workspaces', 'empty'), { recursive: true });
    await assert.rejects(findServerConfig(directory), /found 0/);
    await fs.writeFile(path.join(db, 'mcp_servers.json'), '{}');
    assert.equal(await findServerConfig(directory), path.join(db, 'mcp_servers.json'));
  });
});

test('refuses to pretend a lock exists where the system has none', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(holdFile('any', 'exclusive'), /only on Windows/);
});

test('an exclusive lock makes every other open fail with EBUSY until it is released', windowsOnly, async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'owner.json');
    await fs.writeFile(file, '{"owner":true}');
    const held = await holdFile(file, 'exclusive');
    try {
      await assert.rejects(fs.readFile(file), { code: 'EBUSY' });
      assert.equal((await fs.lstat(file)).isFile(), true);
    } finally { await held.release(); }
    assert.equal(await fs.readFile(file, 'utf8'), '{"owner":true}');
  });
});

test('a reader lock lets reads through but makes a rename over the file fail with EPERM', windowsOnly, async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'approval.json');
    await fs.writeFile(file, 'previous');
    await fs.writeFile(`${file}.next`, 'next');
    const held = await holdFile(file, 'reader');
    try {
      assert.equal(await fs.readFile(file, 'utf8'), 'previous');
      await assert.rejects(fs.rename(`${file}.next`, file), { code: 'EPERM' });
    } finally { await held.release(); }
    await fs.rename(`${file}.next`, file);
    assert.equal(await fs.readFile(file, 'utf8'), 'next');
  });
});

test('an exclusive lock waits briefly while another handle has the file open, then gives up', windowsOnly, async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'mcp_servers.json');
    await fs.writeFile(file, '{}');
    const other = await fs.open(file, 'r');
    const closing = new Promise((resolve) => setTimeout(() => { void other.close().then(resolve); }, 50));
    const held = await holdFile(file, 'exclusive');
    await closing;
    await held.release();

    const stubborn = await fs.open(file, 'r');
    try { await assert.rejects(holdFile(file, 'exclusive', { waitMs: 50 }), { code: 'EBUSY' }); }
    finally { await stubborn.close(); }
  });
});

/** A stand-in installed app: a listing meets an exclusive lock on the file it reads, a writer meets a reader lock. */
function fakeInstalledApp(logs) {
  const app = { listings: 0, approvals: 0, updates: [], holds: [], closed: false, current: undefined };
  const meet = async (label) => {
    logs.push(`[transient-file-retry] ${label} ${app.current.kind === 'exclusive' ? 'EBUSY' : 'EPERM'} after try 1, waiting 50 ms\n`);
    await until(() => !app.current);
  };
  const readerOf = (file) => file.endsWith('owner.json') ? 'owner-policy' : file.endsWith('approval.json') ? 'private-approval' : 'workload-config';
  return {
    app,
    hold: async (file, kind) => { app.current = { file, kind }; app.holds.push([path.basename(file), kind]); return { release: async () => { app.current = undefined; } }; },
    connect: async () => ({
      listResources: async () => {
        app.listings += 1;
        if (app.current?.kind === 'exclusive') await meet(readerOf(app.current.file));
        return { resources: [] };
      },
      close: async () => { app.closed = true; },
    }),
    approve: async () => { app.approvals += 1; if (app.current?.kind === 'reader') await meet('approval-ledger-replace'); },
    update: async (_url, name, patch) => { app.updates.push([name, patch.disabled]); if (app.current?.kind === 'reader') await meet('storage-replace'); },
  };
}

test('the installed smoke lists resources repeatedly, then under every Windows lock, and puts bash back', async () => {
  await withDirectory(async (dataDir) => {
    const db = path.join(dataDir, 'workspaces', 'default-workspace', 'db');
    await fs.mkdir(db, { recursive: true });
    await fs.writeFile(path.join(db, 'mcp_servers.json'), '{}');
    const logs = fakeLogs();
    const fake = fakeInstalledApp(logs);
    const lines = [];
    await probeResourceListing('http://127.0.0.1:1', 'owner-token', { logs, dataDir, platform: 'win32',
      ownerFile: path.join(dataDir, 'owner.json'), approvalFile: path.join(dataDir, 'approval.json'), ...fake, log: (line) => lines.push(line) });
    assert.equal(fake.app.listings, 12 + 4 + 3 + 3);
    assert.deepEqual(fake.app.holds, [['owner.json', 'exclusive'], ['approval.json', 'exclusive'], ['mcp_servers.json', 'exclusive'],
      ['approval.json', 'reader'], ['mcp_servers.json', 'reader']]);
    assert.equal(fake.app.approvals, 1);
    assert.deepEqual(fake.app.updates, [['bash', true], ['bash', false]]);
    assert.equal(lines.length, 5);
    assert.equal(fake.app.closed, true);
  });
});

test('the installed smoke still lists repeatedly where there are no mandatory locks', async () => {
  const logs = fakeLogs();
  const fake = fakeInstalledApp(logs);
  await probeResourceListing('http://127.0.0.1:1', 'owner-token', { logs, dataDir: 'unused', platform: 'linux', ...fake });
  assert.equal(fake.app.listings, 16);
  assert.deepEqual(fake.app.holds, []);
});

test('the installed smoke fails on a refusal the app logged, and on a failed listing', async () => {
  const logs = fakeLogs();
  const refusing = { ...fakeInstalledApp(logs), connect: async () => ({
    listResources: async () => { logs.push('[workload-guard] refused private-files\n'); return { resources: [] }; }, close: async () => {},
  }) };
  await assert.rejects(probeResourceListing('http://127.0.0.1:1', 'owner-token', { logs, dataDir: 'unused', platform: 'linux', ...refusing }),
    /refused during repeated resource listing:\n\[workload-guard\] refused private-files/);

  let closed = false;
  const failing = { ...fakeInstalledApp(logs), connect: async () => ({
    listResources: async () => { throw new Error('HOST_CONSENT_REQUIRED'); }, close: async () => { closed = true; },
  }) };
  await assert.rejects(probeResourceListing('http://127.0.0.1:1', 'owner-token', { logs, dataDir: 'unused', platform: 'linux', ...failing }),
    /HOST_CONSENT_REQUIRED/);
  assert.equal(closed, true);
});
