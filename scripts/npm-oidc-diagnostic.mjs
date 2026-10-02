import { pathToFileURL } from 'node:url';
import { assertOidcOnly, PUBLIC_PACKAGES } from './npm-release.mjs';

const REGISTRY = 'https://registry.npmjs.org';
export function redactDiagnostic(value) {
  return String(value ?? 'No message supplied')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]')
    .replace(/npm_[A-Za-z0-9]+/g, '[redacted npm token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 1024);
}

export async function diagnoseOidc({ env = process.env, request = fetch } = {}) {
  assertOidcOnly(env);
  const results = [];
  const context = { ci: env.CI ?? null, inheritedNpmIdToken: Boolean(env.NPM_ID_TOKEN) };
  for (const name of PUBLIC_PACKAGES) {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set('audience', 'npm:registry.npmjs.org');
    const identity = await request(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    const identityBody = await identity.json();
    if (!identity.ok || typeof identityBody.value !== 'string') {
      results.push({ name, stage: 'github-identity', status: identity.status, message: redactDiagnostic(identityBody.message), authenticated: false });
      continue;
    }
    const claims = JSON.parse(Buffer.from(identityBody.value.split('.')[1], 'base64url').toString('utf8'));
    const publicClaims = Object.fromEntries(['aud', 'repository', 'repository_owner', 'ref', 'sha', 'workflow', 'workflow_ref', 'job_workflow_ref', 'environment', 'event_name'].filter(key => key in claims).map(key => [key, claims[key]]));
    const escaped = name.replace('/', '%2f');
    const exchange = await request(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escaped}`, {
      method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${identityBody.value}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await exchange.json();
    results.push({ name, stage: 'npm-exchange', status: exchange.status, claims: publicClaims,
      authenticated: exchange.ok && typeof body.token === 'string' && body.token.length > 0,
      message: redactDiagnostic(body.message ?? body.error ?? (exchange.ok ? 'Exchange accepted' : undefined)) });
    // Both identity and registry tokens are discarded without logging or saving them.
  }
  return { context, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  diagnoseOidc().then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.results.some(result => !result.authenticated)) process.exitCode = 1;
  }).catch(error => { console.error(`OIDC diagnostic failed: ${redactDiagnostic(error.message)}`); process.exitCode = 1; });
}
