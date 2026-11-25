# Every API route calls `assertUnlocked` first, unless it is on the reviewed list of routes that must work while locked

A new route that skips it serves workspace data while the workspace is locked.
After any route change, `npm run check:routes` runs this and the other route checks.

Enforced by:
- `__tests__/encryption/lockGate.test.ts` (its ALLOWLIST holds the reviewed exceptions)
