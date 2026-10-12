/** Explicit existing-installation fixture; production must never mint this profile. */
export async function seedLegacyDefault() {
  const { wrapKeyring, newKeyring, DEFAULT_PASSWORD } = await import('@/utils/encryption/format');
  const { saveItem } = await import('@/utils/storage/backend');
  const { StorageKey } = await import('@/shared/types/storage');
  await saveItem(StorageKey.ENCRYPTION_KEY, await wrapKeyring(newKeyring(), 'default', DEFAULT_PASSWORD));
}
