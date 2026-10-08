import fs from 'node:fs';
import { capturePackageRunnerAuthorityFence } from '@/backend/services/security/packageRunnerAuthorityFence';
import { createOwnedPrivateApprovalStage } from '@/backend/services/security/ownedPrivateApprovalStage';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

// Actual private files, held descriptors and staged publisher; no authorization
// or filesystem mocks. This is a publication-boundary control, not a complete
// package approval or Windows launcher qualification receipt.
describe('package runner held authority publication fence', () => {
  it('rejects an actual ledger mutation while the owned stage is deferred', async () => {
    const owner = installBundledFixtureOwner();
    const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE!;
    const signal = new AbortController().signal;
    let fence: Awaited<ReturnType<typeof capturePackageRunnerAuthorityFence>> | undefined;
    let stage: Awaited<ReturnType<typeof createOwnedPrivateApprovalStage>> | undefined;
    try {
      fence = await capturePackageRunnerAuthorityFence([process.env.FLUJO_OWNER_AUTH_FILE!, filename], signal);
      stage = await createOwnedPrivateApprovalStage(filename, { schemaVersion: 1, ownerId: 'would-overwrite', approvals: [] }, signal);
      let release!: () => void;
      const deferred = new Promise<void>(resolve => { release = resolve; });
      const publication = (async () => {
        await deferred;
        await stage!.publish(filename, () => fence!.assertCurrent());
      })();
      const changed = { schemaVersion: 1, ownerId: 'external-writer', approvals: [] };
      await fs.promises.writeFile(filename, JSON.stringify(changed));
      release();
      await expect(publication).rejects.toThrow(/authority.*changed|identity.*changed|bytes.*changed/i);
      expect(JSON.parse(await fs.promises.readFile(filename, 'utf8'))).toEqual(changed);
    } finally {
      // Independent close attempts; retain fixture when either cleanup fails.
      const failures: unknown[] = [];
      try { await stage?.dispose(); } catch (error) { failures.push(error); }
      try { await fence?.dispose(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Owned fence fixture cleanup unresolved');
      owner.restore();
    }
  });
});
