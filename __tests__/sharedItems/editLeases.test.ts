/**
 * "Anna is editing" leases (#575, step 575-2): they only inform, end by
 * themselves, and end when the team's generation changes.
 */
import {
  EDIT_LEASE_MS, otherEditors, releaseEditLease, resetEditLeases, takeEditLease,
} from '@/backend/services/sharedItems/editLeases';

const NOW = 1_800_000_000_000;
const lease = (userId: string, name: string, generation = 1) => ({
  workspace: 'sales-ws', kind: 'flow' as const, itemId: 'f1', userId, name, generation,
});

beforeEach(() => resetEditLeases());

describe('edit leases', () => {
  it('tells each editor who else has the item open, without blocking anyone', () => {
    expect(takeEditLease(lease('u_anna', 'Anna'), NOW).others).toEqual([]);
    const ben = takeEditLease(lease('u_ben', 'Ben'), NOW + 1000);
    expect(ben.others).toEqual([{ userId: 'u_anna', name: 'Anna', since: NOW, expiresAt: NOW + EDIT_LEASE_MS }]);
    expect(otherEditors('sales-ws', 'flow', 'f1', 'u_anna', 1, NOW + 2000).map(other => other.name)).toEqual(['Ben']);
    // Another item and another workspace are separate.
    expect(otherEditors('sales-ws', 'flow', 'f2', null, 1, NOW + 2000)).toEqual([]);
    expect(otherEditors('other-ws', 'flow', 'f1', null, 1, NOW + 2000)).toEqual([]);
  });

  it('keeps the start time on renewal and ends 60 seconds after the last renewal', () => {
    takeEditLease(lease('u_anna', 'Anna'), NOW);
    const renewed = takeEditLease(lease('u_anna', 'Anna'), NOW + 20_000);
    expect(renewed.lease).toMatchObject({ since: NOW, expiresAt: NOW + 20_000 + EDIT_LEASE_MS });
    expect(otherEditors('sales-ws', 'flow', 'f1', null, 1, NOW + 20_000 + EDIT_LEASE_MS - 1)).toHaveLength(1);
    // A closed browser stops renewing: the note goes away by itself.
    expect(otherEditors('sales-ws', 'flow', 'f1', null, 1, NOW + 20_000 + EDIT_LEASE_MS)).toEqual([]);
  });

  it('ends leases when the team generation changes (someone was removed or got another role)', () => {
    takeEditLease(lease('u_ben', 'Ben', 1), NOW);
    expect(otherEditors('sales-ws', 'flow', 'f1', 'u_anna', 1, NOW + 10)).toHaveLength(1);
    expect(otherEditors('sales-ws', 'flow', 'f1', 'u_anna', 2, NOW + 20)).toEqual([]);
    // Even going back to the old number does not revive it: it was dropped.
    expect(otherEditors('sales-ws', 'flow', 'f1', 'u_anna', 1, NOW + 30)).toEqual([]);
  });

  it('ends a lease when its person closes the editor', () => {
    takeEditLease(lease('u_ben', 'Ben'), NOW);
    releaseEditLease('sales-ws', 'flow', 'f1', 'u_ben');
    expect(otherEditors('sales-ws', 'flow', 'f1', null, 1, NOW + 1)).toEqual([]);
    expect(() => releaseEditLease('sales-ws', 'flow', 'f1', 'u_ben')).not.toThrow();
  });

  it('forgets expired leases of items nobody looks at again, so memory does not grow', () => {
    for (let index = 0; index < 50; index++) {
      takeEditLease({ ...lease('u_anna', 'Anna'), itemId: `f${index}` }, NOW);
    }
    const shared = global.__flujo_edit_leases!;
    expect(shared.leases.size).toBe(50);
    takeEditLease({ ...lease('u_ben', 'Ben'), itemId: 'fresh' }, NOW + EDIT_LEASE_MS + 31_000);
    expect([...shared.leases.keys()]).toEqual([expect.stringContaining('fresh')]);
  });
});
