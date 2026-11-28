/**
 * Time limit for a test that makes real private approval reads.
 *
 * On Windows every private read starts two fresh native permission checks, each
 * a new PowerShell process: about 0.3 s on an idle PC and several seconds while
 * the PC is busy. A test making a dozen reads therefore needs far more than
 * Jest's 15 s default on a busy Windows PC, although nothing is wrong. Linux and
 * macOS check permissions in-process and keep the default.
 */
export const PRIVATE_READ_TEST_MS = process.platform === 'win32' ? 60_000 : 15_000;
