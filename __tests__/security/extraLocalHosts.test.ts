/**
 * Tests for the `FLUJO_EXTRA_LOCAL_HOSTS` hosted-posture opt-in (#155).
 *
 * When FLUJO runs behind a trusted authenticating proxy on a private network,
 * deployments may extend the localhost origin guard's notion of "local" with
 * exact hostnames or dot-prefixed domain suffixes. These tests prove:
 *   - unset env changes NOTHING (localhost-family only — the standalone default),
 *   - exact entries match only that hostname, suffix entries only sub-hosts,
 *   - the extension applies to Host AND Origin, so the DNS-rebinding rule is
 *     preserved (an attacker Origin still never matches),
 *   - the middleware honors the env end-to-end for a guarded route.
 */

import { NextRequest } from 'next/server';
import { isLocalRequest } from '@/utils/http/localRequest';
import { middleware } from '@/middleware';

const ENV = 'FLUJO_EXTRA_LOCAL_HOSTS';
const savedEnv = process.env[ENV];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe('FLUJO_EXTRA_LOCAL_HOSTS unset (standalone default)', () => {
  it.each([undefined, '', ' , '])('rejects a non-local host when env is %p', (v) => {
    if (v === undefined) delete process.env[ENV];
    else process.env[ENV] = v;
    expect(isLocalRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200', null)).toBe(false);
    expect(isLocalRequest('localhost:4200', null)).toBe(true);
  });
});

describe('FLUJO_EXTRA_LOCAL_HOSTS suffix entries (leading dot)', () => {
  beforeEach(() => {
    process.env[ENV] = '.vm.brain-tenants-dev.internal';
  });

  it('accepts a host under the suffix (no Origin — native/proxy client)', () => {
    expect(isLocalRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200', null)).toBe(true);
  });

  it('matches case-insensitively and still strips the port', () => {
    expect(isLocalRequest('ABC.VM.Brain-Tenants-Dev.INTERNAL:4200', null)).toBe(true);
  });

  it('rejects hosts that merely contain or end-with-but-not-dot-bounded the suffix', () => {
    // No dot boundary violation possible here (suffix starts with '.'), but a
    // different domain that embeds the string must not pass.
    expect(isLocalRequest('vm.brain-tenants-dev.internal.evil.com', null)).toBe(false);
    // The bare apex (suffix minus the dot) is NOT matched by a suffix entry.
    expect(isLocalRequest('vm.brain-tenants-dev.internal', null)).toBe(false);
  });

  it('rejects unrelated hosts and attacker Origins unchanged', () => {
    expect(isLocalRequest('evil.com', null)).toBe(false);
    expect(
      isLocalRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200', 'http://evil.com')
    ).toBe(false);
  });

  it('accepts an Origin under the suffix (browser reaching the trusted name directly)', () => {
    expect(
      isLocalRequest(
        'e82014dc4e5428.vm.brain-tenants-dev.internal:4200',
        'http://e82014dc4e5428.vm.brain-tenants-dev.internal:4200'
      )
    ).toBe(true);
  });

  it('still accepts a localhost Origin with a trusted Host', () => {
    expect(
      isLocalRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200', 'http://localhost:4200')
    ).toBe(true);
  });
});

describe('FLUJO_EXTRA_LOCAL_HOSTS exact entries and lists', () => {
  it('matches an exact entry only (not sub-hosts, not other hosts)', () => {
    process.env[ENV] = 'flujo-box';
    expect(isLocalRequest('flujo-box:4200', null)).toBe(true);
    expect(isLocalRequest('a.flujo-box:4200', null)).toBe(false);
    expect(isLocalRequest('flujo-box2:4200', null)).toBe(false);
  });

  it('supports comma-separated mixed lists with whitespace', () => {
    process.env[ENV] = ' flujo-box , .tenants.internal ';
    expect(isLocalRequest('flujo-box', null)).toBe(true);
    expect(isLocalRequest('m1.tenants.internal:4200', null)).toBe(true);
    expect(isLocalRequest('evil.com', null)).toBe(false);
  });

  it('ignores a bare "." entry (never matches everything)', () => {
    process.env[ENV] = '.';
    expect(isLocalRequest('evil.com', null)).toBe(false);
  });
});

describe('middleware honors FLUJO_EXTRA_LOCAL_HOSTS end-to-end', () => {
  const makeRequest = (host: string, origin?: string): NextRequest => {
    const headers: Record<string, string> = { host };
    if (origin) headers.origin = origin;
    return new NextRequest(`http://${host}/api/cwd`, { method: 'GET', headers });
  };

  it('403s the internal tenant hostname when env is unset', () => {
    delete process.env[ENV];
    const res = middleware(makeRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200'));
    expect(res.status).toBe(403);
  });

  it('passes the internal tenant hostname when the suffix is opted in', () => {
    process.env[ENV] = '.vm.brain-tenants-dev.internal';
    const res = middleware(makeRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200'));
    expect(res.status).not.toBe(403);
  });

  it('still 403s an attacker Origin against the opted-in host', () => {
    process.env[ENV] = '.vm.brain-tenants-dev.internal';
    const res = middleware(
      makeRequest('e82014dc4e5428.vm.brain-tenants-dev.internal:4200', 'http://evil.com')
    );
    expect(res.status).toBe(403);
  });
});
