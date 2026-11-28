// A local npm registry for the operator run. It offers the release under test
// as one more version of its packages and passes every other request through
// to the public registry, so `npx flujo-ai@<new version>` works exactly as it
// will after publication.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';

export const PUBLIC_REGISTRY = 'https://registry.npmjs.org';

/** package.json from an npm tarball (gzip of a tar whose entries start with `package/`). */
export function packageJsonOfTarball(bytes) {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    const body = offset + 512;
    if (name === 'package/package.json') return JSON.parse(tar.subarray(body, body + size).toString('utf8'));
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error('The tarball has no package/package.json.');
}

/** The registry entry npm reads for one version: its manifest plus where and how to fetch it. */
export function versionEntry(manifest, bytes, tarballUrl) {
  return { ...manifest, _id: `${manifest.name}@${manifest.version}`, dist: {
    tarball: tarballUrl,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  } };
}

/** Add (or replace) candidate versions in a package document; `latest` only moves for a new package. */
export function mergePackument(upstream, name, entries) {
  const document = upstream ? structuredClone(upstream) : { name, 'dist-tags': {}, versions: {}, time: {} };
  document.versions ??= {}; document['dist-tags'] ??= {};
  for (const entry of entries) {
    document.versions[entry.version] = entry;
    if (document.time) document.time[entry.version] ??= new Date().toISOString();
  }
  document['dist-tags'].latest ??= entries.at(-1).version;
  return document;
}

const compareVersions = (left, right) => {
  const parts = value => value.split(/[.+-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
};

/**
 * The version an operator upgrades from: `requested` when given, otherwise the
 * newest published one, or the newest older one when the release under test
 * already carries that number.
 */
export function previousVersion(packument, candidate, requested) {
  const published = Object.keys(packument?.versions ?? {}).filter(version => /^\d+\.\d+\.\d+$/.test(version));
  if (requested) {
    if (!published.includes(requested)) throw new Error(`flujo-ai ${requested} is not published.`);
    return requested;
  }
  const latest = packument?.['dist-tags']?.latest;
  if (latest && latest !== candidate && compareVersions(latest, candidate) < 0) return latest;
  const older = published.filter(version => compareVersions(version, candidate) < 0).sort(compareVersions);
  if (!older.length) throw new Error(`No published flujo-ai is older than ${candidate}.`);
  return older.at(-1);
}

/** Start the registry on loopback for the candidate tarballs. */
export async function startRegistry({ tarballs, upstream = PUBLIC_REGISTRY, fetchImpl = fetch }) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = new Map(); const candidates = new Map();
  for (const file of tarballs) {
    const bytes = await readFile(file);
    const manifest = packageJsonOfTarball(bytes);
    const name = path.basename(file);
    files.set(name, bytes);
    candidates.set(manifest.name, [...(candidates.get(manifest.name) ?? []), versionEntry(manifest, bytes, `${base}/-/${name}`)]);
  }
  const fetchUpstream = async (name, accept) => {
    const response = await fetchImpl(`${upstream}/${name.replace('/', '%2f')}`, { headers: { accept: accept ?? 'application/json' }, redirect: 'follow' });
    return { status: response.status, text: await response.text() };
  };
  const send = (response, status, body, type = 'application/json') => { response.writeHead(status, { 'content-type': type }); response.end(body); };
  /** npm fetches published package files through the configured registry too; pass them through as they stream. */
  const passFile = async (rawPath, response) => {
    const upstreamResponse = await fetchImpl(`${upstream}${rawPath}`, { redirect: 'follow' });
    response.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') ?? 'application/octet-stream' });
    if (!upstreamResponse.body) return response.end();
    await pipeline(Readable.fromWeb(upstreamResponse.body), response);
  };
  server.on('request', async (request, response) => {
    try {
      const rawPath = new URL(request.url, base).pathname;
      const pathname = decodeURIComponent(rawPath);
      if (request.method !== 'GET') return send(response, 405, '{"error":"read-only stand-in registry"}');
      if (pathname.startsWith('/-/')) {
        const bytes = files.get(pathname.slice(3));
        return bytes ? send(response, 200, bytes, 'application/octet-stream') : send(response, 404, '{"error":"not found"}');
      }
      if (pathname.includes('/-/')) return await passFile(rawPath, response);
      const name = pathname.slice(1);
      const upstreamDocument = await fetchUpstream(name, request.headers.accept);
      if (!candidates.has(name)) return send(response, upstreamDocument.status, upstreamDocument.text);
      const known = upstreamDocument.status === 200 ? JSON.parse(upstreamDocument.text) : undefined;
      if (!known && upstreamDocument.status !== 404) return send(response, upstreamDocument.status, upstreamDocument.text);
      send(response, 200, JSON.stringify(mergePackument(known, name, candidates.get(name))));
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else send(response, 502, JSON.stringify({ error: `stand-in registry: ${error.message}` }));
    }
  });
  return {
    url: `${base}/`,
    candidates,
    published: async name => {
      const document = await fetchUpstream(name);
      if (document.status !== 200) throw new Error(`The public registry answered ${document.status} for ${name}.`);
      return JSON.parse(document.text);
    },
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(() => resolve())); },
  };
}
