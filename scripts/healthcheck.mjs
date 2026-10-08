#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** No credentials appear in process arguments or output. */
export async function checkHealth({ env = process.env, request = fetch } = {}) {
  const worker = env.FLUJO_WORKER_MODE === '1';
  const token = env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim();
  if (worker && !token) return false;
  const configuredPort = Number(env.FLUJO_PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536 ? configuredPort : 4200;
  try {
    const response = await request(`http://127.0.0.1:${port}/api/${worker ? 'worker/status' : 'cwd'}`, {
      ...(worker ? { headers: { authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return false;
    if (!worker) return true;
    const status = await response.json();
    return status.mode === 'worker' && status.state === 'ready';
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkHealth() ? 0 : 1;
}
