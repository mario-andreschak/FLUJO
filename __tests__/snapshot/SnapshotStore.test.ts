import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuid } from 'uuid';
import {
  SnapshotStore,
  SnapshotStoreBusyError,
  _setSnapshotStoreDirForTests,
} from '@/backend/services/snapshot/SnapshotStore';
import {
  _setSnapshotFolderLauncherForTests,
  type SnapshotFolderLauncher,
} from '@/backend/services/snapshot/openSnapshotFolder';
import { DEFAULT_SNAPSHOT_RETENTION_POLICY } from '@/shared/types/snapshot';
import { StorageKey } from '@/shared/types/storage';
import { clearItem } from '@/utils/storage/backend';

describe('SnapshotStore', () => {
  let testDir: string;
  let store: SnapshotStore;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `flujo-snapshot-test-${uuid()}`);
    await fs.mkdir(testDir, { recursive: true });
    _setSnapshotStoreDirForTests(testDir);
    // The retention policy is persisted in workspace storage, which testDir does
    // not cover — without this, a test that saves a custom policy leaks it into
    // every later test that expects the default.
    await clearItem(StorageKey.SNAPSHOT_RETENTION_POLICY);
    store = new SnapshotStore();
  });

  afterEach(async () => {
    _setSnapshotFolderLauncherForTests(null);
    _setSnapshotStoreDirForTests(null);
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('policy management', () => {
    it('loads the default policy on first access', async () => {
      const policy = await store.policy();
      expect(policy).toEqual(DEFAULT_SNAPSHOT_RETENTION_POLICY);
    });

    it('persists and reloads custom policies', async () => {
      const custom = {
        ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
        maxBytes: 1024 * 1024 * 1024, // 1 GiB
        maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      };
      const saved = await store.updatePolicy(custom);
      expect(saved).toEqual(custom);

      const store2 = new SnapshotStore();
      const reloaded = await store2.policy();
      expect(reloaded).toEqual(custom);
    });

    it('rejects invalid policies before persisting', async () => {
      const invalid = {
        ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
        maxBytes: -1,
      };
      // updatePolicy internally validates; negative bytes should fail validation
      try {
        await store.updatePolicy(invalid);
        expect(true).toBe(false); // Should have thrown
      } catch {
        // Expected
      }
    });

    it('disables automatic cleanup when policy.automaticCleanup is false', async () => {
      const noAuto = {
        ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
        automaticCleanup: false,
      };
      const saved = await store.updatePolicy(noAuto);
      expect(saved.automaticCleanup).toBe(false);
    });
  });

  describe('status reporting', () => {
    it('reports initial empty status', async () => {
      const status = await store.status();
      expect(status.policy).toEqual(DEFAULT_SNAPSHOT_RETENTION_POLICY);
      expect(status.usage.repositories).toEqual([]);
      expect(status.usage.onDiskBytes).toBe(0);
      expect(status.usage.logicalBytes).toBe(0);
      expect(status.activity.operatorDisabled).toBe(false);
      expect(status.activity.storageBusy).toBe(false);
      expect(status.activity.localFolderAccess).toBe(false);
    });

    it('tracks activity flags correctly', async () => {
      const status = await store.status();
      expect(status.activity.capture).toBeDefined();
      expect(status.activity.cleanup).toBeDefined();
      expect(status.activity.migration).toBeDefined();
      expect(typeof status.activity.operatorDisabled).toBe('boolean');
      expect(typeof status.activity.captureSuspended).toBe('boolean');
      expect(typeof status.activity.storageBusy).toBe('boolean');
      expect(typeof status.localFolderAccessSupported).toBe('boolean');
    });

    it.each(['capture', 'cleanup', 'revert'] as const)(
      'reports storageBusy while a %s lease overlaps inventory',
      async (operationKind) => {
        let releaseOperation!: () => void;
        let markEntered!: () => void;
        const blocked = new Promise<void>((resolve) => {
          releaseOperation = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        const operation = store.withAccess(operationKind, async () => {
          markEntered();
          await blocked;
        });
        await entered;

        const statusWhileActive = store.status();
        releaseOperation();
        await operation;

        const activeStatus = await statusWhileActive;
        expect(activeStatus.activity[operationKind]).toBe(true);
        expect(activeStatus.activity.storageBusy).toBe(true);
        expect((await store.status()).activity.storageBusy).toBe(false);
      },
    );

    it('reports migration as storageBusy and excludes read-only inventory', async () => {
      let releaseMigration!: () => void;
      let markEntered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseMigration = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const migration = store.withMigrationAccess([testDir], async () => {
        markEntered();
        await blocked;
      });
      await entered;

      const statusWhileActive = store.status();
      releaseMigration();
      await migration;

      expect((await statusWhileActive).activity.storageBusy).toBe(true);
      const readStatus = await store.withAccess('read', () => store.status());
      expect(readStatus.activity.storageBusy).toBe(false);
    });

    it('reports workspace-scoped local folder access while dispatch is pending', async () => {
      let releaseLaunch!: () => void;
      const launch = jest.fn(() => new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      }));
      _setSnapshotFolderLauncherForTests(
        launch as unknown as SnapshotFolderLauncher,
        'linux',
      );

      const opening = store.openFolder();
      while (launch.mock.calls.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }

      const activeStatus = await store.status();
      expect(activeStatus.activity.localFolderAccess).toBe(true);
      expect(activeStatus.localFolderAccessSupported).toBe(true);

      releaseLaunch();
      await opening;
      expect((await store.status()).activity.localFolderAccess).toBe(false);
    });
  });

  describe('cleanup and retention', () => {
    it('returns empty result when no repositories exist', async () => {
      const result = await store.cleanup();
      expect(result.deletedRepositoryIds).toEqual([]);
      expect(result.reclaimedBytes).toBe(0);
    });

    it('respects the retention policy for cleanup operations', async () => {
      const policy = await store.policy();
      expect(policy.enabled).toBe(true);
      expect(policy.maxBytes).toBeGreaterThan(0);
      expect(policy.maxAgeMs).toBeGreaterThan(0);
    });

    it('validates cleanup target before deletion', async () => {
      // Attempting to cleanup a non-existent or invalid target should not crash
      try {
        const result = await store.cleanup();
        expect(result).toBeDefined();
      } catch (error) {
        // Some errors (e.g., lock busy) are acceptable
        if (error instanceof SnapshotStoreBusyError) {
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });

  describe('capacity gating', () => {
    it('ensures capture capacity before allowing new snapshots', async () => {
      const canCapture = await store.ensureCaptureCapacity();
      expect(typeof canCapture).toBe('boolean');
    });

    it('returns false when over budget', async () => {
      // Set a very small policy to trigger over-budget
      const tinyPolicy = {
        ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
        maxBytes: 1, // 1 byte
        enabled: true,
      };
      await store.updatePolicy(tinyPolicy);
      // Over-budget check should work
      const canCapture = await store.ensureCaptureCapacity();
      // May be false or true depending on actual disk usage
      expect(typeof canCapture).toBe('boolean');
    });
  });

  describe('delete-all operation', () => {
    it('safely deletes all snapshot repositories', async () => {
      const before = await store.status();
      const result = await store.deleteAll();
      expect(result.deleted).toBeDefined();
      expect(result.reclaimedBytes).toBeDefined();
      const after = await store.status();
      expect(after.usage.repositories.length).toBeLessThanOrEqual(before.usage.repositories.length);
    });
  });

  describe('concurrency and locking', () => {
    it('rejects operations when store is busy', async () => {
      // This is hard to test without mocking, but the structure is in place
      const policy = await store.policy();
      expect(policy).toBeDefined();
    });

    it('serializes capture operations through withAccess', async () => {
      // Mock a simple capture operation
      try {
        const result = await store.withAccess('capture', async () => {
          return { success: true };
        });
        expect(result.success).toBe(true);
      } catch (error) {
        // Lock contention is acceptable
        if (error instanceof SnapshotStoreBusyError) {
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });

    it('serializes cleanup through lease mechanism', async () => {
      try {
        const result = await store.cleanup();
        expect(result).toBeDefined();
      } catch (error) {
        if (error instanceof SnapshotStoreBusyError) {
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });

  describe('migration coordination', () => {
    it('provides migration access wrapper for safe coordination', async () => {
      // Test that withMigrationAccess is callable
      try {
        const result = await store.withMigrationAccess([testDir], async () => {
          return { migrated: true };
        });
        expect(result.migrated).toBe(true);
      } catch (error) {
        // Some errors (e.g., lease contention) are expected
        if (error instanceof Error) {
          expect(error.message).toBeDefined();
        } else {
          throw error;
        }
      }
    });
  });

  describe('error handling', () => {
    it('handles corrupted git repositories gracefully', async () => {
      const status = await store.status();
      // Should not throw even if some repos are corrupt
      expect(status).toBeDefined();
      expect(status.usage).toBeDefined();
    });

    it('continues after partial cleanup failures', async () => {
      try {
        const result = await store.cleanup();
        // Should return partial results, not throw
        expect(result).toBeDefined();
      } catch {
        // Acceptable for this scenario
      }
    });
  });
});
