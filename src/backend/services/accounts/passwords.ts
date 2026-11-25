import os from 'node:os';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import {
  PASSWORD_HASH_PATTERN, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SCRYPT_MAXMEM_BYTES, SCRYPT_PARAMETERS,
} from '@/shared/types/accounts';

/**
 * Password hashing for multi-user sign-in (#574), following the OWASP Password
 * Storage Cheat Sheet and NIST SP 800-63B-4: scrypt N=2^17, r=8, p=1 with a
 * 16-byte salt, stored as `scrypt-v1$<logN>$<r>$<p>$<salt>$<hash>`.
 *
 * Hashing runs on libuv's thread pool, never on the event loop. One hash needs
 * about 128 MiB, so the number that run at once follows free memory; extra
 * sign-ins wait their turn for a bounded time and then get "busy, try again"
 * (HTTP 503 with Retry-After), never a lockout.
 */

export class PasswordHashBusyError extends Error {
  readonly status = 503;
  readonly retryAfterSeconds = 2;
  constructor() {
    super('The server is busy checking other sign-ins. Try again in a moment.');
    this.name = 'PasswordHashBusyError';
  }
}

const BYTES_PER_HASH = 128 * 1024 * 1024 * SCRYPT_PARAMETERS.p;
/** How long a sign-in waits for a free hashing slot before the server answers "busy". */
export const HASH_WAIT_MS = 10_000;

interface Waiter { resolve: () => void; timer: ReturnType<typeof setTimeout> }
let running = 0;
const waiting: Waiter[] = [];

/** How many hashes may run now: at least one, more while memory and processors allow. */
export function hashSlots(freeBytes = os.freemem(), processors = os.availableParallelism?.() ?? os.cpus().length): number {
  return Math.max(1, Math.min(processors, Math.floor(freeBytes / (2 * BYTES_PER_HASH))));
}

function release(): void {
  running--;
  while (waiting.length > 0 && running < hashSlots()) {
    const next = waiting.shift()!;
    clearTimeout(next.timer);
    running++;
    next.resolve();
  }
}

async function withHashSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= hashSlots()) {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(new PasswordHashBusyError());
        }, HASH_WAIT_MS),
      };
      waiter.timer.unref?.();
      waiting.push(waiter);
    });
  } else {
    running++;
  }
  try {
    return await task();
  } finally {
    release();
  }
}

function derive(password: string, salt: Buffer, logN: number, r: number, p: number, keyBytes: number): Promise<Buffer> {
  const options: ScryptOptions = { N: 2 ** logN, r, p, maxmem: SCRYPT_MAXMEM_BYTES };
  return withHashSlot(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyBytes, options, (error, key) => error ? reject(error) : resolve(key));
  }));
}

/** Hash a new password with today's settings. `logN` is lowered only by tests, to keep them quick. */
export async function hashPassword(password: string, logN: number = SCRYPT_PARAMETERS.logN): Promise<string> {
  const { r, p, saltBytes, keyBytes } = SCRYPT_PARAMETERS;
  const salt = randomBytes(saltBytes);
  const key = await derive(password, salt, logN, r, p, keyBytes);
  return `scrypt-v1$${logN}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export interface PasswordCheck {
  readonly ok: boolean;
  /** The stored hash uses older settings; store a new one after this successful sign-in. */
  readonly needsRehash: boolean;
}

/** Compare a password with a stored hash in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  if (!PASSWORD_HASH_PATTERN.test(stored) || password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, needsRehash: false };
  }
  const [, logN, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), Number(logN), Number(r), Number(p), expected.length);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  const needsRehash = ok && (Number(logN) < SCRYPT_PARAMETERS.logN || Number(r) !== SCRYPT_PARAMETERS.r
    || Number(p) !== SCRYPT_PARAMETERS.p);
  return { ok, needsRehash };
}

let decoy: Promise<string> | undefined;

/**
 * Spend the same time as a real check when the name is unknown, so the answer
 * time does not tell which names exist.
 */
export async function verifyUnknownUser(password: string): Promise<void> {
  decoy ??= hashPassword(randomBytes(24).toString('base64url'));
  await verifyPassword(password.slice(0, PASSWORD_MAX_LENGTH), await decoy);
}

/** A short list of long passwords that are still guessed first (NIST asks for a blocklist). */
const COMMON_PASSWORDS = new Set([
  '123456789012345', '1234567890123456', '12345678901234567890', '098765432109876', '111111111111111',
  'qwertyuiopasdfg', 'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'qwertyuiop123456', '1qaz2wsx3edc4rfv',
  'passwordpassword', 'password12345678', 'password1234567', 'passw0rdpassw0rd', 'iloveyouiloveyou',
  'abcdefghijklmnop', 'abcdefghijklmno', 'letmeinletmein1', 'welcomewelcome1', 'adminadminadmin',
  'administrator123', 'changemechangeme', 'correcthorsebatterystaple', 'thequickbrownfox',
  'flujoflujoflujo', 'flujopassword123', 'superman1234567', 'trustno1trustno1', 'monkeymonkeymonkey',
]);

function onlyOneCharacter(value: string): boolean {
  return new Set(value).size <= 2;
}

/**
 * Why a new password is not accepted, in plain words, or `null` when it is
 * fine. Only length, the blocklist and the person's own name count; there are
 * no "must contain a digit" rules (NIST SP 800-63B-4).
 */
export function passwordProblem(password: string, names: readonly string[] = []): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. A few ordinary words in a row work well.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const folded = password.toLowerCase();
  if (COMMON_PASSWORDS.has(folded) || onlyOneCharacter(folded)) return 'This password is too easy to guess. Choose another one.';
  for (const name of names) {
    const own = name.trim().toLowerCase();
    if (own.length >= 3 && folded.includes(own) && folded.replaceAll(own, '').length < PASSWORD_MIN_LENGTH / 2) {
      return 'The password must not be mostly your own name.';
    }
  }
  return null;
}
