import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configSchema } from './config.js';
import { createPrivateDirectory, createPrivateFile, syncPrivateDirectory } from './private-storage.js';
import { localExecutable } from './local-executable.js';

/** Creates a new installation without starting a process, pulling an image or
 * contacting a daemon. Existing directories/configuration are never overwritten. */
export function setupController(directory: string, actorId: string, imageId: string): {
  configFile: string; actorId: string; runtimeId: string;
} {
  if (!isAbsolute(directory) || directory.includes('\0')
      || !/^[a-z](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(actorId)) {
    throw new Error('Use an absolute new directory and a lowercase local account name.');
  }
  const root = resolve(directory);
  const runtimeId = `${actorId}-runtime`;
  // Validate all inputs and locate the CLI before creating private storage.
  const config = configSchema.parse({
    schemaVersion: 2, stateDirectory: join(root, 'state'),
    tls: { directory: join(root, 'state', 'tls'), executable: localExecutable('openssl') },
    localEngine: {
      executable: localExecutable('docker'),
      daemon: process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock',
      imageId, memoryMiB: 2048, cpus: 1, pidsLimit: 256, credentialSeconds: 31_536_000,
    },
    runtimes: [{ id: runtimeId, actorId, origin: `https://${actorId}.localhost:4280`,
      upstream: 'http://127.0.0.1:4200', credential: `flo_v1_${randomBytes(32).toString('base64url')}`,
      isolationId: `unprovisioned:${runtimeId}` }],
  });
  createPrivateDirectory(root);
  createPrivateDirectory(config.stateDirectory);
  const configFile = join(root, 'controller.json');
  const fd = createPrivateFile(configFile);
  try { writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncPrivateDirectory(root);
  return { configFile, actorId, runtimeId };
}
