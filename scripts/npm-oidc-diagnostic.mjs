import { pathToFileURL } from 'node:url';
import { assertOidcOnly, PUBLIC_PACKAGES } from './npm-release.mjs';

const REGISTRY = 'https://registry.npmjs.org';
export function redactDiagnostic(value, secrets = []) {
  let message = String(value ?? 'No message supplied');
  for (const secret of [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length > 0))].sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[redacted credential]');
  }
  return message
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]')
    .replace(/npm_[A-Za-z0-9]+/g, '[redacted npm token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 1024);
}

export async function diagnoseOidc({ env = process.env, request = fetch } = {}) {
  assertOidcOnly(env);
  const results = [];
  const context = { ci: env.CI ?? null, inheritedNpmIdToken: Boolean(env.NPM_ID_TOKEN) };
  const secrets = [env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.NPM_ID_TOKEN];
  for (const name of PUBLIC_PACKAGES) {
    let stage = 'github-identity';
    let status = null;
    let publicClaims;
    try {
      const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
      url.searchParams.set('audience', 'npm:registry.npmjs.org');
      const identity = await request(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      });
      status = identity.status;
      const identityBody = await identity.json();
      if (typeof identityBody?.value === 'string') secrets.push(identityBody.value);
      if (!identity.ok || typeof identityBody.value !== 'string') {
        results.push({ name, stage, status, message: redactDiagnostic(identityBody.message, secrets), authenticated: false });
        continue;
      }
      const claims = JSON.parse(Buffer.from(identityBody.value.split('.')[1], 'base64url').toString('utf8'));
      publicClaims = Object.fromEntries(['aud', 'repository', 'repository_owner', 'ref', 'sha', 'workflow', 'workflow_ref', 'job_workflow_ref', 'environment', 'event_name'].filter(key => key in claims).map(key => [key, claims[key]]));
      const escaped = name.replace('/', '%2f');
      stage = 'npm-exchange';
      status = null;
      const exchange = await request(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escaped}`, {
        method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${identityBody.value}` },
        signal: AbortSignal.timeout(30_000),
      });
      status = exchange.status;
      const body = await exchange.json();
      if (typeof body?.token === 'string') secrets.push(body.token);
      results.push({ name, stage, status, claims: publicClaims,
        authenticated: exchange.ok && typeof body.token === 'string' && body.token.length > 0,
        message: redactDiagnostic(body.message ?? body.error ?? (exchange.ok ? 'Exchange accepted' : undefined), secrets) });
      // Both identity and registry tokens are discarded without logging or saving them.
    } catch (error) {
      results.push({ name, stage, status, ...(publicClaims ? { claims: publicClaims } : {}),
        authenticated: false, message: redactDiagnostic(error?.message ?? error, secrets) });
    }
  }
  return { context, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  diagnoseOidc().then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.results.some(result => !result.authenticated)) process.exitCode = 1;
  }).catch(error => { console.error(`OIDC diagnostic failed: ${redactDiagnostic(error.message, [process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, process.env.NPM_ID_TOKEN])}`); process.exitCode = 1; });
}
