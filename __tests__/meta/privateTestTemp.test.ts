import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPrivateApprovalAsync } from '@/backend/services/security/trustedHostMcp';
import { createPrivateTestTemp, removePrivateTestTemp, RUNS_FOLDER, sweepStaleRuns } from '../../scripts/private-test-temp.cjs';

// The shared Jest setup gives every run its own temp root that FLUJO's real
// privacy check accepts (scripts/private-test-temp.cjs). These checks keep that
// promise honest without loosening FLUJO's refusal of folders others can change.
const runRoot = path.dirname(os.tmpdir());

async function writeApproval(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'approval.json');
  await fs.writeFile(filename, JSON.stringify({ approved: true }), { mode: 0o600 });
  return filename;
}

function grantEveryoneModify(directory: string): Promise<void> {
  const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(icacls, [directory, '/grant', '*S-1-1-0:(OI)(CI)M'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`icacls exited with ${code}`))));
  });
}

describe('the test run temp root', () => {
  it('is this run\'s own folder and every temp variable points into it', () => {
    expect(path.basename(path.dirname(runRoot))).toBe(RUNS_FOLDER);
    expect(path.basename(runRoot)).toMatch(/^run-\d+-[0-9a-f]{12}$/);
    expect(process.env.TEMP).toBe(os.tmpdir());
    expect(process.env.TMP).toBe(os.tmpdir());
    expect(process.env.TMPDIR).toBe(os.tmpdir());
    if (process.platform === 'win32') expect(path.dirname(process.env.LOCALAPPDATA!)).toBe(runRoot);
  });

  it('holds approval files that FLUJO\'s own privacy check accepts', async () => {
    const parents = [os.tmpdir(), ...(process.platform === 'win32' ? [process.env.LOCALAPPDATA!] : [])];
    for (const parent of parents) {
      const directory = await fs.mkdtemp(path.join(parent, 'private-proof-'));
      try {
        await expect(readPrivateApprovalAsync(await writeApproval(directory))).resolves.toEqual({ approved: true });
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  }, 60_000);

  it('does not stop FLUJO from refusing a folder other accounts can change', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-proof-'));
    try {
      const filename = await writeApproval(path.join(directory, 'shared'));
      if (process.platform === 'win32') await grantEveryoneModify(path.dirname(filename));
      else await fs.chmod(path.dirname(filename), 0o777);
      const refused = await readPrivateApprovalAsync(filename).then(() => undefined, (error: Error) => error);
      expect(refused?.name).toBe('PrivateApprovalReadError');
      if (process.platform === 'win32') expect(refused?.message).toContain('not private to this account');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 60_000);
});

describe('the private temp helper', () => {
  let scratch: string;
  beforeEach(async () => { scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-')); });
  afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }); });

  const makeFolder = async (directory: string) => { await fs.mkdir(directory, { recursive: true }); return directory; };

  it('moves on to the next base when FLUJO refuses the first, then restores everything', async () => {
    const shared = await makeFolder(path.join(scratch, 'shared-temp'));
    const home = await makeFolder(path.join(scratch, 'home'));
    const env: Record<string, string | undefined> = { TEMP: 'before', LOCALAPPDATA: 'C:\\Local' };
    const state = await createPrivateTestTemp({
      env, bases: [shared, home], ensurePrivateDirectory: makeFolder,
      isPrivate: async (root: string) => !root.startsWith(shared),
    });
    expect(state.private).toBe(true);
    expect(path.dirname(path.dirname(state.root))).toBe(home);
    expect(state.problems).toEqual([expect.stringContaining(shared)]);
    expect(await fs.readdir(shared)).toEqual([]);
    expect(env.TEMP).toBe(state.temp);
    expect(env.TMP).toBe(state.temp);
    if (process.platform === 'win32') {
      expect(env.LOCALAPPDATA).toBe(path.join(state.root, 'local-app-data'));
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(path.join('C:\\Local', 'ms-playwright'));
    }
    await removePrivateTestTemp(state, env);
    expect(env).toEqual({ TEMP: 'before', LOCALAPPDATA: 'C:\\Local' });
    expect(await fs.readdir(home)).toEqual([]);
  });

  it('still gives the run its own root, and says why, when no base is private', async () => {
    const shared = await makeFolder(path.join(scratch, 'shared-temp'));
    const env: Record<string, string | undefined> = {};
    const state = await createPrivateTestTemp({
      env, bases: [shared], ensurePrivateDirectory: makeFolder, isPrivate: async () => false,
    });
    expect(state.private).toBe(false);
    expect(state.problems).toEqual([expect.stringContaining('privacy check refuses')]);
    expect(env.TEMP).toBe(state.temp);
    await removePrivateTestTemp(state, env);
    expect(env).toEqual({});
  });

  it('removes roots of runs that ended without teardown and keeps live ones', async () => {
    const container = await makeFolder(path.join(scratch, RUNS_FOLDER));
    const dead = await makeFolder(path.join(container, 'run-999999-0123456789ab'));
    const live = await makeFolder(path.join(container, `run-${process.pid}-0123456789ab`));
    const unrelated = await makeFolder(path.join(container, 'keep-me'));
    const removed = await sweepStaleRuns(container, { alive: (pid: number) => pid === process.pid });
    expect(removed).toEqual([dead]);
    expect((await fs.readdir(container)).sort()).toEqual([path.basename(unrelated), path.basename(live)].sort());
  });
});
