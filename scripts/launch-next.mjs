#!/usr/bin/env node
/**
 * Launches Next.js with TLS settings that let FLUJO connect to MCP servers whose
 * certificates are signed by a custom/private (enterprise) CA.
 *
 * Node.js does NOT trust the operating system's certificate store by default, which is
 * why a streamable-HTTP MCP server over HTTPS with a corporate CA fails with
 * "unable to verify the first certificate" even though `curl` works. This launcher:
 *
 *   1. Adds `--use-system-ca` to NODE_OPTIONS (Node >= 22.15 / >= 23) so Node trusts the
 *      OS certificate store — the same store `curl` uses.
 *   2. Maps the friendlier FLUJO_EXTRA_CA_CERTS env var to NODE_EXTRA_CA_CERTS so a
 *      specific PEM CA bundle can be trusted without touching the OS store.
 *
 * Both settings propagate to every Node child process Next spawns (including the server),
 * because NODE_OPTIONS / NODE_EXTRA_CA_CERTS are read at process startup.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

// Everything after the script name is the Next.js command, e.g. ["start", "-p", "4200"].
const passthroughArgs = process.argv.slice(2);

const env = { ...process.env };

const [major, minor] = process.versions.node.split('.').map(part => parseInt(part, 10));
const supportsSystemCa = major > 23 || (major === 23) || (major === 22 && minor >= 15);

if (supportsSystemCa && !/--use-system-ca/.test(env.NODE_OPTIONS || '')) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--use-system-ca`;
} else if (!supportsSystemCa) {
  console.warn(
    `[FLUJO] Node ${process.versions.node} does not support --use-system-ca. ` +
    `To trust a custom CA, set NODE_EXTRA_CA_CERTS (or FLUJO_EXTRA_CA_CERTS) to your CA file ` +
    `before starting FLUJO.`
  );
}

// Convenience alias so users don't have to remember the exact Node env var name.
if (env.FLUJO_EXTRA_CA_CERTS && !env.NODE_EXTRA_CA_CERTS) {
  env.NODE_EXTRA_CA_CERTS = env.FLUJO_EXTRA_CA_CERTS;
}

const tlsSummary = [
  env.NODE_OPTIONS ? `NODE_OPTIONS="${env.NODE_OPTIONS}"` : null,
  env.NODE_EXTRA_CA_CERTS ? `NODE_EXTRA_CA_CERTS="${env.NODE_EXTRA_CA_CERTS}"` : null,
].filter(Boolean).join(', ');
console.log(`[FLUJO] Starting next ${passthroughArgs.join(' ')}${tlsSummary ? ` (${tlsSummary})` : ''}`);

// On Windows the resolved binary is next.cmd, which requires a shell to execute.
const child = spawn('next', passthroughArgs, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
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
