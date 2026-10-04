/** Existing public-password profile fixture; never used for fresh installation. */
export async function seedExistingDefaultProfile(): Promise<void> {
  const { wrapKeyring, newKeyring, DEFAULT_PASSWORD } = await import('@/utils/encryption/format');
  const { saveItem } = await import('@/utils/storage/backend');
  const { StorageKey } = await import('@/shared/types/storage');
  await saveItem(StorageKey.ENCRYPTION_KEY, await wrapKeyring(newKeyring(), 'default', DEFAULT_PASSWORD));
}
