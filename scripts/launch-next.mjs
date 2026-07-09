#!/usr/bin/env node
/**
 * Launches Next.js with TLS settings that let FLUJO connect to MCP servers whose
 * certificates are signed by a custom/private (enterprise) CA.
 *
 * Node.js does NOT trust the operating system's certificate store by default, which is
 * why a streamable-HTTP MCP server over HTTPS with a corporate CA fails with
 * "unable to verify the first certificate" even though `curl` works. This launcher:
 *
 *   1. Adds `--use-system-ca` to NODE_OPTIONS (on Node versions that support it) so Node
 *      trusts the OS certificate store — the same store `curl` uses.
 *   2. Maps the friendlier FLUJO_EXTRA_CA_CERTS env var to NODE_EXTRA_CA_CERTS so a
 *      specific PEM CA bundle can be trusted without touching the OS store.
 *
 * Both settings propagate to every Node child process Next spawns (including the server),
 * because NODE_OPTIONS / NODE_EXTRA_CA_CERTS are read at process startup.
 *
 * The TLS/CA logic is exported as `buildLaunchEnv()` so the npm-package bin wrapper
 * (bin/flujo.mjs, issue #59) reuses it verbatim instead of duplicating it.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Return a copy of `baseEnv` with FLUJO's TLS/CA settings applied:
 *  - NODE_OPTIONS gains `--use-system-ca` on Node versions that support it.
 *  - FLUJO_EXTRA_CA_CERTS is mirrored to NODE_EXTRA_CA_CERTS.
 * Pure apart from a one-time informational log on older Node builds.
 */
export function buildLaunchEnv(baseEnv = process.env) {
  const env = { ...baseEnv };

  // Detect support empirically instead of sniffing the version number. This Set is the
  // authoritative list of flags THIS Node binary accepts inside NODE_OPTIONS, so it is
  // correct across versions, platforms, and nightly/RC builds — and it guarantees we never
  // inject a flag that Node would then reject at startup with a scary error.
  const supportsSystemCa = process.allowedNodeEnvironmentFlags.has('--use-system-ca');

  if (supportsSystemCa && !/--use-system-ca/.test(env.NODE_OPTIONS || '')) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--use-system-ca`;
  } else if (!supportsSystemCa && !env.NODE_EXTRA_CA_CERTS && !env.FLUJO_EXTRA_CA_CERTS) {
    // Not an error — older Node simply lacks the flag and falls back to Node's bundled CAs.
    // Only surface this (as info, not a warning) when no CA bundle is already configured,
    // so it never looks alarming on the happy path.
    console.log(
      `[FLUJO] Node ${process.versions.node} has no --use-system-ca flag; using Node's bundled CAs. ` +
      `If an MCP server uses a private/corporate CA, set FLUJO_EXTRA_CA_CERTS (or NODE_EXTRA_CA_CERTS) ` +
      `to your CA file before starting FLUJO.`
    );
  }

  // Convenience alias so users don't have to remember the exact Node env var name.
  if (env.FLUJO_EXTRA_CA_CERTS && !env.NODE_EXTRA_CA_CERTS) {
    env.NODE_EXTRA_CA_CERTS = env.FLUJO_EXTRA_CA_CERTS;
  }

  return env;
}

/** Spawn `next <passthroughArgs>` with the TLS-configured env and forward its exit. */
function launchNext(passthroughArgs) {
  const env = buildLaunchEnv();

  const tlsSummary = [
    env.NODE_OPTIONS ? `NODE_OPTIONS="${env.NODE_OPTIONS}"` : null,
    env.NODE_EXTRA_CA_CERTS ? `NODE_EXTRA_CA_CERTS="${env.NODE_EXTRA_CA_CERTS}"` : null,
  ].filter(Boolean).join(', ');
  console.log(`[FLUJO] Starting next ${passthroughArgs.join(' ')}${tlsSummary ? ` (${tlsSummary})` : ''}`);

  // Resolve Next's own CLI from node_modules and run it with the current Node binary.
  // Never rely on a `next` on PATH: npm injects node_modules/.bin into PATH for `npm run`
  // scripts, but this launcher is also invoked directly (e.g. the Docker CMD), where that
  // PATH entry is absent and `spawn('next')` fails with ENOENT. Resolving the JS entry and
  // spawning `node <entry>` works identically on every platform and needs no shell.
  let nextBin;
  try {
    nextBin = require.resolve('next/dist/bin/next');
  } catch (error) {
    console.error('[FLUJO] Could not locate the Next.js binary in node_modules. Run `npm install` first.', error);
    process.exit(1);
  }

  const child = spawn(process.execPath, [nextBin, ...passthroughArgs], {
    stdio: 'inherit',
    env,
  });

  child.on('error', error => {
    console.error('[FLUJO] Failed to launch next:', error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

// Only launch when run directly (`node scripts/launch-next.mjs start -p 4200`), not when
// imported for buildLaunchEnv (bin/flujo.mjs). Everything after the script name is the
// Next.js command, e.g. ["start", "-p", "4200"].
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  launchNext(process.argv.slice(2));
}
