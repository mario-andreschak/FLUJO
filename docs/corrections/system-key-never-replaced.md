# A system key that protected saved credentials is never replaced by a new one: a lost or unreadable key asks for the recovery key, and tests never touch the computer's real key store

Starting over with a fresh key would make every saved credential unreadable
for good. `getSystemSecret` creates a key only while no record exists, and the
unlock dialog accepts the recovery key, which then goes back into the store.

Enforced by:
- `__tests__/encryption/systemKey.test.ts`
- `getSystemSecret` in `src/utils/encryption/systemKey.ts`
- `FLUJO_SYSTEM_KEY_STORE` in `jest.setup.ts`
