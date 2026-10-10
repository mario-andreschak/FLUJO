#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Readiness probe. Credentials and response bodies never enter diagnostics. */
export async function checkHealth({ env = process.env, request = fetch } = {}) {
  const worker = env.FLUJO_WORKER_MODE === '1';
  const configuredPort = env.FLUJO_PORT;
  // Only an absent port uses the default. A typo must not probe another service.
  if (configuredPort !== undefined && (typeof configuredPort !== 'string'
      || !/^[0-9]{1,5}$/.test(configuredPort))) return false;
  const port = configuredPort === undefined ? 4200 : Number(configuredPort);
  if (port < 1 || port > 65535) return false;

  // Worker authority remains separate: an owner credential cannot replace it.
  const configuredToken = worker ? env.FLUJO_SNAPSHOT_CONTROL_TOKEN : env.FLUJO_HEALTHCHECK_TOKEN;
  if (configuredToken !== undefined && typeof configuredToken !== 'string') return false;
  const token = configuredToken?.trim();
  if ((worker || configuredToken !== undefined) && (!token || !/^[\x21-\x7e]+$/.test(token))) return false;
  try {
    const response = await request(`http://127.0.0.1:${port}/api/${worker ? 'worker/status' : 'cwd'}`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      // Never send a bearer to a redirect target or accept a login page as ready.
      redirect: 'error',
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return false;
    const status = await response.json();
    return worker ? status?.mode === 'worker' && status.state === 'ready' : status?.success === true;
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkHealth() ? 0 : 1;
}
