// A local stand-in for the FLUJO package registry: it serves the packages it is given, read-only,
// on 127.0.0.1 and a free port, so a check can install a package without the internet or an account.
// It speaks the anonymous read routes of src/backend/utils/packageRegistryClient.ts.
import { createServer } from 'node:http';

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** `packages` maps a package id (`owner/name`) to its manifest object. */
export async function startStandInRegistry(packages = new Map()) {
  const requests = [];
  const summary = (id, manifest) => ({
    id, name: manifest.name ?? id, description: manifest.description ?? '', latestVersion: manifest.version, tags: manifest.tags ?? [],
    publisher: id.split('/')[0], downloads: 0, updatedAt: new Date(0).toISOString(),
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method !== 'GET') return send(response, 405, { error: 'This stand-in registry is read-only.' });
    if (url.pathname === '/v1/packages') {
      const items = [...packages].map(([id, manifest]) => summary(id, manifest));
      return send(response, 200, { items, page: 1, pageSize: items.length || 20, total: items.length });
    }
    const match = /^\/v1\/packages\/([^/]+)(?:\/versions\/([^/]+)\/manifest)?$/.exec(url.pathname);
    const id = match ? decodeURIComponent(match[1]) : undefined;
    const manifest = id ? packages.get(id) : undefined;
    if (!manifest) return send(response, 404, { error: 'No such package in the stand-in registry.' });
    if (match[2] === undefined) return send(response, 200, { ...summary(id, manifest), versions: [{ version: manifest.version }] });
    if (match[2] !== 'latest' && match[2] !== manifest.version) return send(response, 404, { error: 'No such version.' });
    return send(response, 200, manifest);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    packages,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
