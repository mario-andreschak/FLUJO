import { scryptSync } from 'node:crypto';
import {
  hashPassword, hashSlots, passwordProblem, verifyPassword,
} from '@/backend/services/accounts/passwords';
import {
  recordFailedSignIn, recordSuccessfulSignIn, resetSignInThrottle, signInWaitMs,
} from '@/backend/services/accounts/signInThrottle';
import {
  PASSWORD_HASH_PATTERN, SCRYPT_MAXMEM_BYTES, SIGN_IN_DELAY_FIRST_MS, SIGN_IN_DELAY_MAX_MS,
} from '@/shared/types/accounts';
import { TEST_LOG_N } from './helpers';

describe('password hashing', () => {
  it('hashes with the contract settings (needs the raised memory limit) and verifies', async () => {
    expect(() => scryptSync('x', 'salt', 32, { N: 2 ** 17, r: 8, p: 1 })).toThrow(/memory/i);
    expect(() => scryptSync('x', 'salt', 32, { N: 2 ** 17, r: 8, p: 1, maxmem: SCRYPT_MAXMEM_BYTES })).not.toThrow();
    const stored = await hashPassword('a perfectly long passphrase');
    expect(stored).toMatch(PASSWORD_HASH_PATTERN);
    expect(stored.startsWith('scrypt-v1$17$8$1$')).toBe(true);
    expect(await verifyPassword('a perfectly long passphrase', stored)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword('a perfectly long passphrasE', stored)).toEqual({ ok: false, needsRehash: false });
  }, 30_000);

  it('still accepts older settings and asks for a stronger hash after success', async () => {
    const stored = await hashPassword('an older but valid passphrase', TEST_LOG_N);
    expect(await verifyPassword('an older but valid passphrase', stored)).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword('wrong', stored)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword('anything', 'not-a-hash')).toEqual({ ok: false, needsRehash: false });
  });

  it('runs at least one hash at a time, more while memory allows', () => {
    expect(hashSlots(0, 8)).toBe(1);
    expect(hashSlots(64 * 1024 ** 3, 8)).toBe(8);
    expect(hashSlots(1024 ** 3, 8)).toBe(4);
  });

  it('accepts long passwords without composition rules and refuses weak ones in plain words', () => {
    expect(passwordProblem('correct horse battery')).toBeNull();
    expect(passwordProblem('short')).toMatch(/at least 15/);
    expect(passwordProblem('passwordpassword')).toMatch(/too easy/);
    expect(passwordProblem('aaaaaaaaaaaaaaaaaaaa')).toMatch(/too easy/);
    expect(passwordProblem('annaannaanna1234', ['anna'])).toMatch(/own name/);
    expect(passwordProblem('x'.repeat(257))).toMatch(/at most/);
  });
});

describe('slowing down repeated failed sign-ins', () => {
  beforeEach(() => resetSignInThrottle());

  it('doubles the wait per failure up to 15 minutes and clears on success', () => {
    const now = 1_000_000;
    expect(signInWaitMs('Anna', now)).toBe(0);
    expect(recordFailedSignIn('anna', now)).toBe(SIGN_IN_DELAY_FIRST_MS);
    expect(signInWaitMs('ANNA', now + 10)).toBe(SIGN_IN_DELAY_FIRST_MS - 10);
    expect(recordFailedSignIn('anna', now + 2000)).toBe(2 * SIGN_IN_DELAY_FIRST_MS);
    let wait = 0;
    for (let index = 0; index < 40; index++) wait = recordFailedSignIn('anna', now + 3000);
    expect(wait).toBe(SIGN_IN_DELAY_MAX_MS);
    expect(signInWaitMs('ben', now)).toBe(0);
    recordSuccessfulSignIn('anna');
    expect(signInWaitMs('anna', now + 3000)).toBe(0);
  });

  it('forgets a name that stayed quiet after its wait, so it is never a lockout', () => {
    const now = 5_000_000;
    recordFailedSignIn('cleo', now);
    recordFailedSignIn('cleo', now + 1000);
    expect(signInWaitMs('cleo', now + 1000 + 2 * SIGN_IN_DELAY_FIRST_MS)).toBe(0);
    const later = now + 1000 + 2 * SIGN_IN_DELAY_FIRST_MS + SIGN_IN_DELAY_MAX_MS;
    expect(recordFailedSignIn('cleo', later)).toBe(SIGN_IN_DELAY_FIRST_MS);
  });
});
