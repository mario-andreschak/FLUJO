/**
 * The certificate authorities this computer trusts, from the operating
 * system's own store (the Windows certificate store, the macOS keychain, the
 * system certificate folder on Linux): the same store the official MCPB tool
 * checks signatures against (#1230). Authorities an administrator gives Node
 * through its standard `NODE_EXTRA_CA_CERTS` file count as well.
 *
 * Reading the store blocks for tens of milliseconds, so it runs once in a
 * worker thread and the certificates are parsed a batch at a time. A read that
 * fails or takes too long counts as "no trusted authorities" for that one
 * check, and the next check reads again, so nothing stays broken until a
 * restart.
 */
import { X509Certificate } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/mcpb/trustedRoots');

const READ_TIMEOUT_MS = 20_000;
const PARSE_BATCH = 32;

/** Runs in a worker thread and posts the trusted certificates as PEM text. */
export const TRUSTED_ROOTS_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const tls = require('node:tls');
const read = (type) => {
  try {
    return tls.getCACertificates(type);
  } catch {
    return [];
  }
};
parentPort.postMessage(typeof tls.getCACertificates === 'function' ? [...read('system'), ...read('extra')] : []);
`;

function readSystemStore(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(TRUSTED_ROOTS_WORKER_SOURCE, { eval: true });
    const stop = () => {
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Reading the trusted certificates took longer than ${READ_TIMEOUT_MS / 1000} seconds.`));
    }, READ_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (pems: unknown) => {
      stop();
      resolve(Array.isArray(pems) ? pems.filter((pem): pem is string => typeof pem === 'string') : []);
    });
    worker.once('error', (error) => {
      stop();
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Reading the trusted certificates stopped early (exit code ${code}).`));
    });
  });
}

async function parseCertificates(pems: readonly string[]): Promise<X509Certificate[]> {
  const certificates: X509Certificate[] = [];
  for (let index = 0; index < pems.length; index++) {
    try {
      certificates.push(new X509Certificate(pems[index]));
    } catch (error) {
      log.debug('Skipped a trusted certificate Node cannot read', error);
    }
    if ((index + 1) % PARSE_BATCH === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return certificates;
}

let loaded: Promise<readonly X509Certificate[]> | undefined;

/** The trusted certificate authorities, read once per process. */
export async function systemTrustedRoots(): Promise<readonly X509Certificate[]> {
  loaded ??= readSystemStore().then(parseCertificates);
  const current = loaded;
  try {
    return await current;
  } catch (error) {
    if (loaded === current) loaded = undefined;
    log.warn('Could not read the trusted certificates; the next signature check tries again.', error);
    return [];
  }
}
