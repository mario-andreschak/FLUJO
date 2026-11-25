# A workspace without its key file (`db/encryption_key.json`) is locked only when it holds encrypted secrets, never just because it runs on a worker

Enforced by:
- `findStoredCiphertext` in `src/utils/encryption/storedCiphertext.ts`
- `__tests__/encryption/missingMetadataLock.test.ts`
