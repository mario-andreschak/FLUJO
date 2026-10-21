import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readPrivateFile } from './private-storage.js';
import { admittedModelBody, MODEL_RESPONSE_BYTES, type ModelGrant, type ModelOperation } from './model-grant.js';

/** Fixed local destination and operation. Node HTTP uses no proxy environment,
 * redirect following, caller headers, provider SDK, retry or model fallback. */
export async function localModelRequest(grant: ModelGrant, operation: ModelOperation, value: unknown,
  signal: AbortSignal, current: () => boolean, headers: (type: 'application/json' | 'text/event-stream') => Promise<void>,
  chunk: (bytes: Buffer) => Promise<void>): Promise<void> {
  const check = () => { if (signal.aborted || !current()) throw new Error('Local model authority unavailable.'); };
  check();
  if (operation === 'models') {
    await headers('application/json'); check();
    await chunk(Buffer.from(JSON.stringify({ object: 'list', data: grant.models.map(id => ({ id, object: 'model', created: 0, owned_by: 'local' })) })));
    return;
  }
  const body = admittedModelBody(grant, operation, value);
  const endpoint = new URL(`${grant.endpoint}/${operation === 'chat' ? 'chat/completions' : 'embeddings'}`);
  const authorization = grant.bearerFile ? readPrivateFile(grant.bearerFile, 8192).toString('utf8').trim() : undefined;
  if (authorization !== undefined && (!authorization || /[\x00-\x20\x7f]/.test(authorization))) throw new Error('Local model credential unavailable.');
  const ca = grant.caFile ? readPrivateFile(grant.caFile, 128 * 1024) : undefined;
  check();
  const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
    method: 'POST', agent: false, signal, maxHeaderSize: 16 * 1024,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
      'Accept-Encoding': 'identity', 'Content-Length': Buffer.byteLength(body),
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
    ...(ca ? { ca } : {}),
  });
  let response: IncomingMessage | undefined;
  const connecting = setTimeout(() => request.destroy(new Error('Local model connection unavailable.')), 10_000);
  request.on('socket', socket => {
    if (!socket.connecting) clearTimeout(connecting);
    else socket.once(endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connecting));
  });
  // The persistent listener also absorbs errors after the response promise settles.
  request.on('error', () => {});
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve); request.once('error', reject); request.end(body);
    });
    check();
    const type = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300
        || (type !== 'application/json' && type !== 'text/event-stream')
        || (operation === 'embeddings' && type !== 'application/json')
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      throw new Error('Local model response unavailable.');
    }
    await headers(type); let received = 0;
    for await (const bytes of response) {
      check(); received += bytes.length;
      if (received > MODEL_RESPONSE_BYTES) throw new Error('Local model response exceeds limit.');
      for (let at = 0; at < bytes.length; at += 48 * 1024) {
        check(); await chunk(bytes.subarray(at, at + 48 * 1024));
      }
    }
    check();
    if (!response.complete) throw new Error('Local model response incomplete.');
  } finally { clearTimeout(connecting); response?.destroy(); request.destroy(); }
}
