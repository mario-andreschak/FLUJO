// Acceptance-only observer: preserve fetch behavior and emit no OAuth values.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const watched = (url.origin === 'https://banking-mcp.com'
    && ['/api/oauth/register', '/api/oauth/token'].includes(url.pathname))
    || (url.origin === 'https://slack.com' && url.pathname === '/api/oauth.v2.user.access');
  let request;
  if (watched) {
    request = { type: 'oauth-wire', operation: url.pathname.endsWith('/register') ? 'register' : 'token' };
    if (request.operation === 'register') {
      const body = JSON.parse(init.body);
      request.applicationType = body.application_type;
      request.tokenEndpointAuthMethod = ['none', 'client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method)
        ? body.token_endpoint_auth_method : 'other';
      request.loopbackRedirect = body.redirect_uris.length === 1
        && new URL(body.redirect_uris[0]).hostname === '127.0.0.1';
    } else {
      const body = new URLSearchParams(init.body);
      const grant = body.get('grant_type');
      request.grantType = ['authorization_code', 'refresh_token'].includes(grant) ? grant : 'other';
      request.hasVerifier = body.has('code_verifier');
      request.hasResource = body.has('resource');
      request.hasClientSecret = body.has('client_secret');
    }
  }
  const response = await originalFetch(input, init);
  if (request) process.send?.({ ...request, status: response.status });
  return response;
};
