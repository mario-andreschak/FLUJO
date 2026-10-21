/** Immutable provisioned environment, not a request header or persisted app
 * preference. The controller verifies these values before admitting transport. */
export function managedSandboxOwnerOrigin(): string | undefined {
  if (process.env.FLUJO_CONTAINER !== '1'
      || process.env.FLUJO_OWNER_AUTH_FILE !== '/run/flujo-owner/owner.json') return undefined;
  const value = process.env.FLUJO_OWNER_BROWSER_ORIGIN;
  if (!value) throw new Error('Managed sandbox owner origin is missing');
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== 'https:'
      || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/.test(url.hostname)) {
    throw new Error('Managed sandbox requires the provisioned local owner origin');
  }
  return url.origin;
}
