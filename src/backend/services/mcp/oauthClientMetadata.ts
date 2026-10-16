import hostedClientMetadata from '../../../../githubpages/oauth/client-metadata.json';

/** Public client identity hosted by FLUJO's existing GitHub Pages deployment. */
export const FLUJO_OAUTH_CLIENT_METADATA_URL = hostedClientMetadata.client_id;

/** Custom deployments must publish a document allowing their exact callback URI. */
export function resolveOAuthClientMetadataUrl(redirectUri: string): string | undefined {
  const configured = process.env.FLUJO_OAUTH_CLIENT_METADATA_URL;
  if (configured !== undefined) {
    let url: URL;
    try { url = new URL(configured); }
    catch { throw new Error('FLUJO_OAUTH_CLIENT_METADATA_URL must be an HTTPS URL with a document path.'); }
    if (configured !== configured.trim() || url.protocol !== 'https:' || url.pathname === '/'
        || url.username || url.password || url.hash) {
      throw new Error('FLUJO_OAUTH_CLIENT_METADATA_URL must be an HTTPS URL with a document path, without credentials or a fragment.');
    }
    return configured;
  }
  // Never identify a remote/custom-port installation using a document whose
  // redirect allowlist does not cover it. Operators can host their own on Pages.
  return hostedClientMetadata.redirect_uris.includes(redirectUri)
    ? FLUJO_OAUTH_CLIENT_METADATA_URL : undefined;
}
