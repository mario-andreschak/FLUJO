import fs from 'node:fs';
import { capturePackageRunnerAuthorityFence } from '@/backend/services/security/packageRunnerAuthorityFence';
import { createOwnedPrivateApprovalStage } from '@/backend/services/security/ownedPrivateApprovalStage';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

// Actual private files, held descriptors and staged publisher; no authorization
// or filesystem mocks. This is a publication-boundary control, not a complete
// package approval or Windows launcher qualification receipt.
describe('package runner held authority publication fence', () => {
  it('rejects an actual ledger mutation after the publisher reads its held stage', async () => {
    const owner = installBundledFixtureOwner();
    const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE!;
    const signal = new AbortController().signal;
    let fence: Awaited<ReturnType<typeof capturePackageRunnerAuthorityFence>> | undefined;
    let stage: Awaited<ReturnType<typeof createOwnedPrivateApprovalStage>> | undefined;
    let release: (() => void) | undefined;
    let publication: Promise<void> | undefined;
    try {
      fence = await capturePackageRunnerAuthorityFence([process.env.FLUJO_OWNER_AUTH_FILE!, filename], signal);
      stage = await createOwnedPrivateApprovalStage(filename, { schemaVersion: 1, ownerId: 'would-overwrite', approvals: [] }, signal);
      const deferred = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const heldRead = new Promise<void>(resolve => { entered = resolve; });
      publication = stage.publish(filename, () => fence!.assertCurrent(), async () => {
        entered();
        await deferred;
      });
      // Observe rejection immediately, including failures before the barrier.
      const outcome = publication.then(() => ({ error: undefined }), error => ({ error }));
      await Promise.race([heldRead, outcome.then(result => {
        if (result.error) throw result.error;
        throw new Error('Publication completed without reaching its actual held read');
      })]);
      const changed = { schemaVersion: 1, ownerId: 'external-writer', approvals: [] };
      await fs.promises.writeFile(filename, JSON.stringify(changed));
      release!();
      await expect(publication).rejects.toThrow(/authority.*changed|identity.*changed|bytes.*changed/i);
      expect(JSON.parse(await fs.promises.readFile(filename, 'utf8'))).toEqual(changed);
    } finally {
      release?.();
      try { await publication; } catch { /* Asserted publication refusal above. */ }
      // Independent close attempts; retain fixture when either cleanup fails.
      const failures: unknown[] = [];
      try { await stage?.dispose(); } catch (error) { failures.push(error); }
      try { await fence?.dispose(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Owned fence fixture cleanup unresolved');
      owner.restore();
    }
  });
});
