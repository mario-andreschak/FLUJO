/**
 * Tests for the git-based shadow-repository snapshot service (issue #250).
 *
 * Verifies the acceptance criteria that are checkable at the service layer:
 *  - capture records a snapshot; files() lists the changed path,
 *  - capture is disabled (returns null) when the root is not a git repo,
 *  - capture is disabled when snapshots are switched off (FLUJO_SNAPSHOTS=0),
 *  - revert restores exactly the selected paths and leaves unrelated edits alone,
 *  - revert is reversible (returns a pre-revert snapshot SHA),
 *  - the user's OWN git state (HEAD / index / status) is provably untouched,
 *  - capture failure degrades to null and never throws.
 *
 * Requires a real `git` binary (present on dev + CI + Docker images).
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

import {
  shadowRepoService,
  _setShadowRepoDirForTests,
} from '@/backend/services/snapshot/ShadowRepoService';
import { snapshotStore } from '@/backend/services/snapshot/SnapshotStore';
import { DEFAULT_SNAPSHOT_RETENTION_POLICY } from '@/shared/types/snapshot';

async function mkTemp(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Create a real git repo with one committed file and return its path. */
async function makeRealRepo(): Promise<string> {
  const dir = await mkTemp('flujo-snap-repo-');
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'dev@flujo.local');
  await git.addConfig('user.name', 'Dev');
  await git.addConfig('commit.gpgsign', 'false');
  await fsp.writeFile(path.join(dir, 'kept.txt'), 'original\n', 'utf-8');
  await git.add('.');
  await git.commit('initial');
  return dir;
}

describe('ShadowRepoService', () => {
  let shadowDir: string;
  let prevShadow: string | null;
  const prevEnv = process.env.FLUJO_SNAPSHOTS;

  beforeEach(async () => {
    shadowDir = await mkTemp('flujo-shadow-');
    prevShadow = _setShadowRepoDirForTests(shadowDir);
    delete process.env.FLUJO_SNAPSHOTS;
    loadItemMock.mockReset();
    loadItemMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    _setShadowRepoDirForTests(prevShadow);
    if (prevEnv === undefined) delete process.env.FLUJO_SNAPSHOTS;
    else process.env.FLUJO_SNAPSHOTS = prevEnv;
    await fsp.rm(shadowDir, { recursive: true, force: true }).catch(() => {});
  });

  it('captures a snapshot and lists the changed file via files()', async () => {
    const repo = await makeRealRepo();
    try {
      const before = await shadowRepoService.capture(repo);
      expect(before).toBeTruthy();

      await fsp.writeFile(path.join(repo, 'kept.txt'), 'changed\n', 'utf-8');
      await fsp.writeFile(path.join(repo, 'added.txt'), 'new\n', 'utf-8');

      const after = await shadowRepoService.capture(repo);
      expect(after).toBeTruthy();
      expect(after).not.toEqual(before);

      const changed = await shadowRepoService.files(repo, before!, after!);
      const paths = changed.map((c) => c.path).sort();
      expect(paths).toEqual(['added.txt', 'kept.txt']);

      const diff = await shadowRepoService.diff(repo, before!, after!);
      expect(diff).toContain('changed');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('keeps retained SHAs usable after packed-history cleanup', async () => {
    const repo = await makeRealRepo();
    try {
      loadItemMock.mockResolvedValue({
        ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
        maxCapturesPerRoot: 1,
      });
      const first = await shadowRepoService.capture(repo);
      await fsp.writeFile(path.join(repo, 'kept.txt'), 'second\n', 'utf-8');
      const retained = await shadowRepoService.capture(repo);
      expect(first).toBeTruthy();
      expect(retained).toBeTruthy();

      await fsp.writeFile(path.join(repo, 'kept.txt'), 'working-tree\n', 'utf-8');
      const changed = await shadowRepoService.files(repo, retained!);
      expect(changed).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'kept.txt' }),
      ]));
      expect((await snapshotStore.usage()).repositories[0]?.commitCount).toBe(1);
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports damaged shadow repositories as corrupt', async () => {
    const repo = await makeRealRepo();
    try {
      expect(await shadowRepoService.capture(repo)).toBeTruthy();
      const [repositoryId] = await fsp.readdir(shadowDir);
      const gitDir = path.join(shadowDir, repositoryId, 'git');
      const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
      const headRef = head.startsWith('ref: ')
        ? path.join(gitDir, ...head.slice('ref: '.length).split('/'))
        : path.join(gitDir, 'HEAD');
      await fsp.mkdir(path.dirname(headRef), { recursive: true });
      await fsp.writeFile(headRef, 'not-a-sha\n', 'utf8');

      const usage = await snapshotStore.usage();
      expect(usage.repositories).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: repositoryId, health: 'corrupt' }),
      ]));
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('disables snapshots when the persisted setting is off', async () => {
    const repo = await makeRealRepo();
    try {
      loadItemMock.mockResolvedValue({
        experimental: { enabled: false, snapshotsEnabled: false },
      });
      expect(await shadowRepoService.isEnabledFor(repo)).toBe(false);
      expect(await shadowRepoService.capture(repo)).toBeNull();
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('keeps snapshots enabled when the persisted setting is absent', async () => {
    const repo = await makeRealRepo();
    try {
      loadItemMock.mockResolvedValue({ experimental: { enabled: false } });
      expect(await shadowRepoService.isEnabledFor(repo)).toBe(true);
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('keeps the environment disable authoritative over the persisted setting', async () => {
    const repo = await makeRealRepo();
    try {
      process.env.FLUJO_SNAPSHOTS = '0';
      loadItemMock.mockResolvedValue({
        experimental: { enabled: false, snapshotsEnabled: true },
      });
      expect(await shadowRepoService.isEnabledFor(repo)).toBe(false);
      expect(loadItemMock).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns null when the target is not a git repository', async () => {
    const plain = await mkTemp('flujo-plain-');
    try {
      expect(await shadowRepoService.isEnabledFor(plain)).toBe(false);
      await fsp.writeFile(path.join(plain, 'a.txt'), 'x', 'utf-8');
      expect(await shadowRepoService.capture(plain)).toBeNull();
    } finally {
      await fsp.rm(plain, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns null (never throws) for a non-existent root', async () => {
    const missing = path.join(os.tmpdir(), 'flujo-does-not-exist-' + Date.now());
    await expect(shadowRepoService.capture(missing)).resolves.toBeNull();
  });

  it('is disabled when snapshots are switched off (FLUJO_SNAPSHOTS=0)', async () => {
    const repo = await makeRealRepo();
    try {
      process.env.FLUJO_SNAPSHOTS = '0';
      expect(await shadowRepoService.isEnabledFor(repo)).toBe(false);
      expect(await shadowRepoService.capture(repo)).toBeNull();
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reverts only the selected paths and leaves unrelated edits alone', async () => {
    const repo = await makeRealRepo();
    try {
      await fsp.writeFile(path.join(repo, 'target.txt'), 'v1\n', 'utf-8');
      const baseline = await shadowRepoService.capture(repo);
      expect(baseline).toBeTruthy();

      // Change the target file AND an unrelated file, then create a new file.
      await fsp.writeFile(path.join(repo, 'target.txt'), 'v2\n', 'utf-8');
      await fsp.writeFile(path.join(repo, 'unrelated.txt'), 'keep-me\n', 'utf-8');
      await fsp.writeFile(path.join(repo, 'created.txt'), 'created-after\n', 'utf-8');
      await shadowRepoService.capture(repo);

      const preRevert = await shadowRepoService.revert(repo, baseline!, [
        'target.txt',
        'created.txt',
      ]);
      expect(preRevert).toBeTruthy(); // reversible: pre-revert anchor returned

      // target.txt restored to its baseline content.
      expect(await fsp.readFile(path.join(repo, 'target.txt'), 'utf-8')).toBe('v1\n');
      // created.txt (added after baseline) removed by the revert.
      await expect(fsp.access(path.join(repo, 'created.txt'))).rejects.toBeTruthy();
      // unrelated.txt was NOT in the path list → untouched.
      expect(await fsp.readFile(path.join(repo, 'unrelated.txt'), 'utf-8')).toBe('keep-me\n');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("leaves the user's own git state (HEAD, index, status) untouched", async () => {
    const repo = await makeRealRepo();
    try {
      const realGit = simpleGit(repo);
      const headBefore = (await realGit.revparse(['HEAD'])).trim();
      const statusBefore = await realGit.status();

      // Make a change and capture it into the shadow repo several times.
      await fsp.writeFile(path.join(repo, 'kept.txt'), 'mutated\n', 'utf-8');
      await shadowRepoService.capture(repo);
      await shadowRepoService.capture(repo);

      const headAfter = (await realGit.revparse(['HEAD'])).trim();
      const statusAfter = await realGit.status();

      // Real repo HEAD never advanced (no commit landed in the user's repo).
      expect(headAfter).toBe(headBefore);
      // The only worktree change is our own edit; the index is not staged by us
      // (shadow uses a SEPARATE gitdir), so kept.txt shows as not-staged.
      expect(statusAfter.staged).toEqual(statusBefore.staged);
      expect(statusAfter.staged).toEqual([]);
      expect(statusAfter.modified).toContain('kept.txt');
    } finally {
      await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
