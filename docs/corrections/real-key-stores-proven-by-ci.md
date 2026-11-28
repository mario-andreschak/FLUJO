# FLUJO's system key is proven against the real key store of every system by CI, never left for a person to try on a Mac or a Linux desktop

The first version of #1443 ended with "Manual: try it on a real Mac and on a
Linux desktop". Fake stores hid that a locked Linux keyring answers "not
found", so FLUJO told the owner their key was gone after a password reset.
`scripts/check-system-key-store.mjs` now runs the real-store suite on each
system (on Linux in a throwaway GNOME keyring, then locked, without a keyring
service and without a session), and the broad qualification must run it.

Enforced by:
- `assertSystemKeyStoreJobs` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
- `scripts/check-system-key-store.test.mjs`
- `__tests__/encryption/secretServiceStore.test.ts`

Verified by:
- `npm run check:system-key-store`
