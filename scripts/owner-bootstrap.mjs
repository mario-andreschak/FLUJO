import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Local OS-owner provisioning. Secret bytes go only into an exclusive private file. */
export function provisionOwnerBootstrap(directory, ownerId, now = Date.now()) {
  if (!path.isAbsolute(directory) || !/^[A-Za-z0-9_-]{1,64}$/.test(ownerId)
      || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid local pairing configuration.');
  const resolved = path.resolve(directory);
  const dataRoot = path.resolve(process.env.FLUJO_PARENT_DATA_DIR?.trim() || process.env.FLUJO_DATA_DIR?.trim() || process.cwd());
  const dataRoots = [dataRoot];
  try { dataRoots.push(fs.realpathSync(dataRoot)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (dataRoots.some(root => {
    const relative = path.relative(root, resolved);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) throw new Error('Pairing must be outside the data directory.');
  if (fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)) throw new Error('Pairing parent must be canonical.');
  fs.mkdirSync(resolved, { mode: 0o700 }); // Never reuse or overwrite an existing authority directory.
  const directoryIdentity = fs.lstatSync(resolved, { bigint: true });
  if (!directoryIdentity.isDirectory() || fs.realpathSync(resolved) !== resolved
      || (process.platform !== 'win32' && (directoryIdentity.mode & BigInt(0o077)) !== BigInt(0))) throw new Error('Invalid private directory.');
  const token = `flo_v1_${randomBytes(32).toString('base64url')}`;
  const issuedAt = now; const expiresAt = now + 15 * 60 * 1000;
  const policy = { schemaVersion: 1, ownerId, credentials: [{ id: randomBytes(16).toString('hex'),
    digest: createHash('sha256').update(token).digest('hex'), scopes: ['control:admin', 'secrets:read'],
    issuedAt, expiresAt, revokedAt: null }] };
  const bootstrapFile = path.join(resolved, 'bootstrap.json');
  const pairingTokenFile = path.join(resolved, 'pairing-token');
  for (const [file, bytes] of [[bootstrapFile, JSON.stringify(policy)], [pairingTokenFile, token]]) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(file, { bigint: true });
      const parent = fs.lstatSync(resolved, { bigint: true });
      if (!opened.isFile() || opened.nlink !== BigInt(1) || opened.dev !== named.dev || opened.ino !== named.ino
          || parent.dev !== directoryIdentity.dev || parent.ino !== directoryIdentity.ino || fs.realpathSync(resolved) !== resolved) throw new Error('Private pairing path changed.');
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  return { policyFile: path.join(resolved, 'owner.json'), bootstrapFile, pairingTokenFile, expiresAt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error();
    process.stdout.write(JSON.stringify(provisionOwnerBootstrap(process.argv[2], process.argv[3])) + '\n');
  } catch { process.stderr.write('Local owner pairing provisioning failed. Use a new private absolute directory and a valid owner id. Preserve existing authority.\n'); process.exitCode = 1; }
}
