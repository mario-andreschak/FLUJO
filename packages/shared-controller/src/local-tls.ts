import { createPrivateKey, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ControllerConfig } from './config.js';
import { certificateCommand } from './certificate-command.js';
import { assertPrivateDirectory, createPrivateDirectory, readPrivateFile } from './private-storage.js';
import { publishPrivateFile } from './private-publish.js';

const day = 86_400_000;
const generation = z.string().regex(/^[a-f0-9]{32}$/);
const fingerprint = z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
const rootSchema = z.object({ schemaVersion: z.literal(1), generation, fingerprint: fingerprint.optional() }).strict();
const leafSchema = z.object({ schemaVersion: z.literal(1), generation, rootFingerprint: fingerprint,
  hosts: z.array(z.string().regex(/^(?:\*\.)?[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/)).min(1).max(2000) }).strict();
type TLSConfig = NonNullable<ControllerConfig['tls']>;
export interface LocalTLSMaterial {
  key: Buffer; cert: Buffer; notBefore: number; expiresAt: number;
  fingerprint: string; rootFingerprint: string; caFile: string;
}
const invalid = () => new Error('Local TLS state is unavailable or inconsistent. Preserve it for local recovery.');
const encoded = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const key = (): string => generateKeyPairSync('ec', { namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const serial = (): string => `0x01${randomBytes(16).toString('hex')}`;

function fixedFile(filename: string, contents: string): void {
  if (!existsSync(filename)) publishPrivateFile(filename, contents);
  if (readPrivateFile(filename).toString() !== contents) throw invalid();
}

function period(certificate: X509Certificate): { notBefore: number; expiresAt: number } {
  const notBefore = Date.parse(certificate.validFrom); const expiresAt = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || expiresAt <= notBefore) throw invalid();
  return { notBefore, expiresAt };
}

/** Read only the already pinned public root. Never bootstrap or replace trust. */
export function localTLSRoot(config: ControllerConfig, allowExpired = false): { certificate: X509Certificate; caFile: string; keyFile: string } {
  if (!config.tls) throw invalid();
  const record = rootSchema.parse(JSON.parse(readPrivateFile(join(config.tls.directory, 'root.json')).toString()));
  if (!record.fingerprint) throw invalid();
  const caFile = join(config.tls.directory, `root-${record.generation}.pem`);
  const certificate = new X509Certificate(readPrivateFile(caFile));
  const dates = period(certificate);
  if (!certificate.ca || !certificate.verify(certificate.publicKey) || certificate.fingerprint256 !== record.fingerprint
      || (!allowExpired && (dates.notBefore > Date.now() || dates.expiresAt <= Date.now()))) throw invalid();
  return { certificate, caFile, keyFile: join(config.tls.directory, `root-${record.generation}.key`) };
}

async function initializeRoot(tls: TLSConfig): Promise<void> {
  if (!existsSync(tls.directory)) createPrivateDirectory(tls.directory);
  assertPrivateDirectory(tls.directory);
  const journal = join(tls.directory, 'root.json');
  if (!existsSync(journal)) {
    // A missing pointer alongside issued keys/certificates is loss of authority
    // metadata, not permission to manufacture a replacement trusted identity.
    if (readdirSync(tls.directory).some(name => !/^\.candidate-[a-f0-9]{32}$/.test(name))) throw invalid();
    publishPrivateFile(journal, encoded({ schemaVersion: 1, generation: randomBytes(16).toString('hex') }));
  }
  const original = readPrivateFile(journal);
  const record = rootSchema.parse(JSON.parse(original.toString()));
  if (record.fingerprint) return; // Pinned roots may only be restored, never silently replaced.
  const keyFile = join(tls.directory, `root-${record.generation}.key`);
  const caFile = join(tls.directory, `root-${record.generation}.pem`);
  if (!existsSync(keyFile)) publishPrivateFile(keyFile, key());
  const privateKey = createPrivateKey(readPrivateFile(keyFile));
  const configuration = join(tls.directory, 'root-openssl.cnf');
  fixedFile(configuration, '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=FLUJO local installation CA\n[root]\n'
    + 'basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n'
    + 'nameConstraints=critical,permitted;DNS:.localhost\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n');
  if (!existsSync(caFile)) {
    const cert = await certificateCommand(tls.executable, ['req', '-new', '-x509', '-batch', '-sha256', '-key', keyFile,
      '-days', '3650', '-set_serial', serial(), '-config', configuration, '-extensions', 'root'], tls.directory, '', configuration);
    const parsed = new X509Certificate(cert);
    if (!parsed.ca || !parsed.checkPrivateKey(privateKey) || !parsed.verify(parsed.publicKey)) throw invalid();
    publishPrivateFile(caFile, cert);
  }
  const certificate = new X509Certificate(readPrivateFile(caFile));
  if (!certificate.ca || !certificate.checkPrivateKey(privateKey) || !certificate.verify(certificate.publicKey)) throw invalid();
  publishPrivateFile(journal, encoded({ ...record, fingerprint: certificate.fingerprint256 }), original);
}

function readLeaf(tls: TLSConfig, record: z.infer<typeof leafSchema>, root: ReturnType<typeof localTLSRoot>): LocalTLSMaterial {
  const leafKey = readPrivateFile(join(tls.directory, `leaf-${record.generation}.key`));
  const cert = readPrivateFile(join(tls.directory, `leaf-${record.generation}.pem`));
  const leaf = new X509Certificate(cert);
  const dates = period(leaf); const rootDates = period(root.certificate);
  const names = leaf.subjectAltName?.split(', ').map(name => name.startsWith('DNS:') ? name.slice(4) : '').sort();
  if (leaf.ca || !leaf.checkPrivateKey(createPrivateKey(leafKey)) || !leaf.checkIssued(root.certificate)
      || !leaf.verify(root.certificate.publicKey) || record.rootFingerprint !== root.certificate.fingerprint256
      || dates.notBefore < rootDates.notBefore || dates.expiresAt > rootDates.expiresAt
      || !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || JSON.stringify(names) !== JSON.stringify(record.hosts)
      || record.hosts.some(host => !host.startsWith('*.')
        && leaf.checkHost(host, { subject: 'never', wildcards: false }) !== host)) throw invalid();
  return { key: leafKey, cert, ...dates, fingerprint: leaf.fingerprint256,
    rootFingerprint: root.certificate.fingerprint256, caFile: root.caFile };
}

/** Caller holds the controller lock. Only owner localhost names and their
 * single-label app namespaces are signed; never a general *.localhost wildcard.
 * Root identity is pinned durably; leaf publication is atomic and recoverable. */
export async function ensureLocalTLS(config: ControllerConfig, options: { initialize?: boolean; renew?: boolean } = {}): Promise<LocalTLSMaterial> {
  const tls = config.tls;
  if (!tls) throw invalid();
  if (options.initialize) await initializeRoot(tls);
  const root = localTLSRoot(config);
  const hosts = config.runtimes.flatMap(runtime => {
    const host = new URL(runtime.origin).hostname;
    return runtime.localRuntime ? [host, `*.${host}`] : [host];
  }).sort();
  const filename = join(tls.directory, 'current.json');
  const original = existsSync(filename) ? readPrivateFile(filename) : undefined;
  if (original) {
    const record = leafSchema.parse(JSON.parse(original.toString()));
    const material = readLeaf(tls, record, root);
    if (material.notBefore > Date.now()) throw invalid();
    if (!options.renew && material.expiresAt > Date.now() + 14 * day && JSON.stringify(record.hosts) === JSON.stringify(hosts)) return material;
  }
  // A nearly expired root requires an explicit new local trust ceremony. Never
  // manufacture a new CA or extend trust as a side effect of a leaf renewal.
  if (period(root.certificate).expiresAt < Date.now() + 91 * day) throw invalid();
  const record = leafSchema.parse({ schemaVersion: 1, generation: randomBytes(16).toString('hex'),
    rootFingerprint: root.certificate.fingerprint256, hosts });
  const keyFile = join(tls.directory, `leaf-${record.generation}.key`);
  const certFile = join(tls.directory, `leaf-${record.generation}.pem`);
  const configuration = join(tls.directory, `leaf-${record.generation}.cnf`);
  publishPrivateFile(keyFile, key());
  fixedFile(configuration, '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=FLUJO local controller\n[leaf]\n'
    + 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
    + `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`);
  // OpenSSL 3 req can issue directly with the pinned CA; no CSR, serial file,
  // AIA/OCSP/CRL URL, ACME request or global OpenSSL configuration is used.
  const cert = await certificateCommand(tls.executable, ['req', '-new', '-x509', '-batch', '-sha256', '-key', keyFile,
    '-CA', root.caFile, '-CAkey', root.keyFile, '-days', '90', '-set_serial', serial(),
    '-config', configuration, '-extensions', 'leaf'], tls.directory, '', configuration);
  publishPrivateFile(certFile, cert);
  const material = readLeaf(tls, record, root);
  if (material.notBefore > Date.now() || material.expiresAt <= Date.now() + 89 * day) throw invalid();
  publishPrivateFile(filename, encoded(record), original);
  return material;
}

export class LocalTLS {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  constructor(readonly config: ControllerConfig, public material: LocalTLSMaterial) {}
  valid(): boolean { return this.material.notBefore <= Date.now() && this.material.expiresAt > Date.now(); }
  start(replace: (material: LocalTLSMaterial) => void): void {
    this.timer = setInterval(() => {
      if (this.closed || this.pending) return;
      this.pending = ensureLocalTLS(this.config).then(material => {
        if (!this.closed && material.fingerprint !== this.material.fingerprint) { replace(material); this.material = material; }
      }).catch(() => {
        process.stderr.write('Local TLS renewal failed; check private certificate state and the local signing tool.\n');
      }).finally(() => { this.pending = undefined; });
    }, 6 * 60 * 60 * 1000);
    this.timer.unref();
  }
  async stop(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.pending; }
}
