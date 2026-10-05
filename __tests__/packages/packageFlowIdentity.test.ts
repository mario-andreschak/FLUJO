import {
  deterministicFlowId, hasConflictingFlowClaim, resolvePackageFlowIds,
} from '@/backend/services/packages/packageFlowIdentity';

const occupied = (...ids: string[]) => new Set(ids);

describe('package flow identity and legacy ownership', () => {
  it('uses the complete digest in a stable filename-safe identity', () => {
    const id = deterministicFlowId('my-pkg', 'local-root');
    expect(id).toBe('49dce82c2d109956d0f7ed39b135c82bbc90a9600c8b23a62f190b835150d4e1');
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(id, 'hex')).toHaveLength(32);
  });

  it('separates the reproduced 32-bit suffix collision', () => {
    const name = 'collision-probe-' + 'x'.repeat(80);
    const ids = resolvePackageFlowIds(name, ['flow-00045416', 'flow-00139699'], {}, occupied());
    expect(new Set(Object.values(ids)).size).toBe(2);
  });

  it('keeps distinct slug-normalized inputs distinct', () => {
    expect(deterministicFlowId('Pkg Name', 'a.b')).not.toBe(deterministicFlowId('pkg-name', 'a-b'));
  });

  it('does not alias tuples containing the old delimiter', () => {
    expect(deterministicFlowId('a::b', 'c')).not.toBe(deterministicFlowId('a', 'b::c'));
  });

  it.each([true, false])('retains an unambiguous legacy mapping (flow present: %s)', (present) => {
    const ledger = { pkg: { entities: { flows: { local: 'legacy-flow' } } } };
    expect(resolvePackageFlowIds('pkg', ['local'], ledger, occupied(...(present ? ['legacy-flow'] : []))))
      .toEqual({ local: 'legacy-flow' });
  });

  it('refuses an occupied new identity without recorded ownership', () => {
    const id = deterministicFlowId('pkg', 'local');
    expect(() => resolvePackageFlowIds('pkg', ['local'], {}, occupied(id))).toThrow('ownership');
  });

  it('does not adopt an occupied legacy slug without a ledger', () => {
    const ids = resolvePackageFlowIds('pkg', ['local'], {}, occupied('pkg-pkg-local'));
    expect(ids.local).not.toBe('pkg-pkg-local');
  });

  it('refuses an occupied identity with different filesystem casing', () => {
    const id = deterministicFlowId('pkg', 'local');
    expect(() => resolvePackageFlowIds('pkg', ['local'], {}, occupied(id.toUpperCase()))).toThrow('ownership');
  });

  it('rejects duplicate local identities', () => {
    expect(() => resolvePackageFlowIds('pkg', ['local', 'local'], {}, occupied())).toThrow('ownership');
  });

  it('refuses a legacy ID shared by two local flows', () => {
    const ledger = { pkg: { entities: { flows: { first: 'legacy-flow', second: 'legacy-flow' } } } };
    expect(() => resolvePackageFlowIds('pkg', ['first'], ledger, occupied('legacy-flow'))).toThrow('ownership');
  });

  it('refuses a legacy ID claimed by another package', () => {
    const ledger = {
      pkg: { entities: { flows: { local: 'legacy-flow' } } },
      other: { entities: { flows: { foreign: 'legacy-flow' } } },
    };
    expect(hasConflictingFlowClaim(ledger, 'pkg', 'local', 'legacy-flow')).toBe(true);
    expect(() => resolvePackageFlowIds('pkg', ['local'], ledger, occupied('legacy-flow'))).toThrow('ownership');
  });

  it('rejects an unsafe recorded identity before it can become a path', () => {
    const ledger = { pkg: { entities: { flows: { local: '../foreign' } } } };
    expect(() => resolvePackageFlowIds('pkg', ['local'], ledger, occupied())).toThrow('ownership');
  });

  it.each(['__proto__', 'constructor'])('preserves an own mapping named %s', (key) => {
    const ledger = JSON.parse(JSON.stringify({ [key]: { entities: { flows: { [key]: 'legacy-special' } } } }));
    const ids = resolvePackageFlowIds(key, [key], ledger, occupied('legacy-special'));
    expect(Object.hasOwn(ids, key)).toBe(true);
    expect(JSON.parse(JSON.stringify(ids))).toEqual({ [key]: 'legacy-special' });
  });
});
