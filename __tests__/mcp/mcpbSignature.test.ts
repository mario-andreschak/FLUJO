/**
 * MCP bundle signatures (#1230): a signed bundle counts as signed only when the
 * signature matches the file, was made with the certificate it carries, that
 * certificate is valid and may sign software, and it leads to a trusted
 * authority. Every signature here is made in the test, except one bundle that
 * the official `mcpb sign` (2.1.2) signed, which proves the bytes match the
 * real tool.
 */
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { X509Certificate } from 'crypto';
import {
  checkMcpbSignature,
  signatureProblemText,
  signedParts,
  splitMcpbSignature,
  type SignatureCheckOptions,
} from '@/backend/services/mcp/mcpb/signature';
import { systemTrustedRoots, TRUSTED_ROOTS_WORKER_SOURCE } from '@/backend/services/mcp/mcpb/trustedRoots';
import { makeCertificate, OIDS, signBundle, type TestCertificate } from './fixtures/mcpbSigning';

const DAY = 24 * 60 * 60 * 1000;
const FIXTURES = path.join(__dirname, 'fixtures', 'mcpb-signed');

let root: TestCertificate;
let signingCa: TestCertificate;
let leaf: TestCertificate;

beforeAll(() => {
  root = makeCertificate({ commonName: 'FLUJO Test Root CA', organization: 'FLUJO tests', ca: true });
  signingCa = makeCertificate({ commonName: 'FLUJO Test Signing CA', organization: 'FLUJO tests', ca: true, issuer: root });
  leaf = makeCertificate({ commonName: 'Ada Example', organization: 'Example Tools', issuer: signingCa, extendedKeyUsage: [OIDS.codeSigning] });
});

async function zip(text = 'console.log("hello from the bundle")'): Promise<Buffer> {
  const archive = new JSZip();
  archive.file('manifest.json', JSON.stringify({ name: 'hello-bundle' }));
  archive.file('server/index.js', text);
  return archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

function check(bytes: Buffer, roots: X509Certificate[] = [root.x509], options: SignatureCheckOptions = {}) {
  return checkMcpbSignature(bytes, splitMcpbSignature(bytes), { trustedRoots: async () => roots, ...options });
}

function withBlock(zipBytes: Buffer, pkcs7: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(pkcs7.length);
  return Buffer.concat([zipBytes, Buffer.from('MCPB_SIG_V1'), size, pkcs7, Buffer.from('MCPB_SIG_END')]);
}

describe('a valid signature', () => {
  it('is trusted through a trusted authority and names who signed it', async () => {
    const signature = await check(signBundle(await zip(), leaf, { chain: [signingCa] }));
    expect(signature).toEqual({
      status: 'signed',
      signer: {
        name: 'Ada Example',
        organization: 'Example Tools',
        issuer: 'FLUJO Test Signing CA',
        validFrom: leaf.x509.validFromDate.toISOString(),
        validTo: leaf.x509.validToDate.toISOString(),
        fingerprint: leaf.x509.fingerprint256,
      },
    });
  });

  it('matches the official tool: a bundle signed by mcpb 2.1.2 with a real certificate chain', async () => {
    const bytes = await fs.readFile(path.join(FIXTURES, 'hello-signed-by-mcpb-2.1.2.mcpb'));
    const testRoot = new X509Certificate(await fs.readFile(path.join(FIXTURES, 'test-root-ca.pem')));
    const now = new Date('2027-06-01T00:00:00Z');

    const trusted = await check(bytes, [testRoot], { now });
    expect(trusted).toMatchObject({ status: 'signed', signer: { name: 'Ada Example', organization: 'Example Tools', issuer: 'FLUJO Test Signing CA' } });

    expect(await check(bytes, [], { now })).toMatchObject({ status: 'unsigned', signer: { name: 'Ada Example' } });

    const changed = await fs.readFile(path.join(FIXTURES, 'hello-changed-after-signing.mcpb'));
    expect(changed.length).toBe(bytes.length);
    expect(await check(changed, [testRoot], { now })).toMatchObject({ status: 'invalid', problem: 'changed' });

    expect(await check(bytes, [testRoot], { now: new Date('2040-01-01T00:00:00Z') })).toMatchObject({ status: 'invalid', problem: 'expired' });
  });

  it('reads the zip comment length the way old and new mcpb versions write it', async () => {
    const plain = await zip();
    for (const keepCommentLength of [true, false]) {
      const signed = signBundle(plain, leaf, { chain: [signingCa], keepCommentLength });
      const split = splitMcpbSignature(signed);
      expect(Buffer.concat(signedParts(signed, split.content.length)).equals(plain)).toBe(true);
      expect((await check(signed)).status).toBe('signed');
    }
  });

  it('accepts other ways of signing: by key id, without signed attributes, RSA as mcpb writes it, RSA-PSS, Ed25519', async () => {
    expect((await check(signBundle(await zip(), leaf, { chain: [signingCa], byKeyId: true }))).status).toBe('signed');

    const rsa = makeCertificate({ commonName: 'RSA Signer', issuer: signingCa, keyType: 'rsa', extendedKeyUsage: [OIDS.codeSigning] });
    expect((await check(signBundle(await zip(), rsa, { chain: [signingCa] }))).status).toBe('signed');
    expect((await check(signBundle(await zip(), rsa, { chain: [signingCa], withoutAttributes: true }))).status).toBe('signed');
    expect((await check(signBundle(await zip(), rsa, { chain: [signingCa], pss: true }))).status).toBe('signed');

    const edwards = makeCertificate({ commonName: 'Edwards Signer', keyType: 'ed25519' });
    expect(await check(signBundle(await zip(), edwards), [edwards.x509])).toMatchObject({ status: 'signed', signer: { name: 'Edwards Signer' } });
  });

  it('trusts a self-signed certificate only when the computer trusts that certificate itself', async () => {
    const own = makeCertificate({ commonName: 'In-house Tools', extendedKeyUsage: [OIDS.codeSigning] });
    const bytes = signBundle(await zip(), own);
    expect(await check(bytes)).toMatchObject({ status: 'unsigned', signer: { name: 'In-house Tools' } });
    expect(await check(bytes, [own.x509])).toMatchObject({ status: 'signed', signer: { name: 'In-house Tools' } });
  });
});

describe('a signature that does not hold up', () => {
  it('refuses a bundle that was changed after signing', async () => {
    const signed = signBundle(await zip(), leaf, { chain: [signingCa] });
    const at = signed.indexOf('hello from the bundle');
    signed.write('HELLO', at);
    const signature = await check(signed);
    expect(signature).toMatchObject({ status: 'invalid', problem: 'changed', signer: { name: 'Ada Example' } });
    expect(signatureProblemText(signature)).toBe('The bundle was changed after it was signed.');
  });

  it('refuses a signature made with a different key than the certificate it carries', async () => {
    const other = makeCertificate({ commonName: 'Someone Else', issuer: signingCa, extendedKeyUsage: [OIDS.codeSigning] });
    expect(await check(signBundle(await zip(), leaf, { chain: [signingCa], signingKey: other }))).toMatchObject({ status: 'invalid', problem: 'wrong-certificate' });
  });

  it('refuses expired and not yet valid certificates, anywhere in the chain', async () => {
    const expired = makeCertificate({
      commonName: 'Old Signer', issuer: signingCa, extendedKeyUsage: [OIDS.codeSigning],
      notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY),
    });
    const signature = await check(signBundle(await zip(), expired, { chain: [signingCa] }));
    expect(signature).toMatchObject({ status: 'invalid', problem: 'expired', signer: { name: 'Old Signer' } });
    expect(signatureProblemText(signature)).toBe(`The certificate that signed it expired on ${expired.x509.validToDate.toISOString().slice(0, 10)}.`);

    const early = makeCertificate({ commonName: 'Early Signer', issuer: signingCa, notBefore: new Date(Date.now() + DAY), extendedKeyUsage: [OIDS.codeSigning] });
    expect(await check(signBundle(await zip(), early, { chain: [signingCa] }))).toMatchObject({ status: 'invalid', problem: 'not-yet-valid' });

    const oldCa = makeCertificate({ commonName: 'Old CA', ca: true, issuer: root, notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) });
    const underOldCa = makeCertificate({ commonName: 'Under Old CA', issuer: oldCa, extendedKeyUsage: [OIDS.codeSigning] });
    expect(await check(signBundle(await zip(), underOldCa, { chain: [oldCa] }))).toMatchObject({ status: 'invalid', problem: 'expired' });
  });

  it('refuses a certificate that may not sign software', async () => {
    const website = makeCertificate({ commonName: 'example.com', issuer: signingCa, extendedKeyUsage: [OIDS.serverAuth] });
    expect(await check(signBundle(await zip(), website, { chain: [signingCa] }))).toMatchObject({ status: 'invalid', problem: 'not-for-code-signing' });
  });

  it('refuses outdated signing methods', async () => {
    expect(await check(signBundle(await zip(), leaf, { chain: [signingCa], digestOid: OIDS.sha1 }))).toMatchObject({ status: 'invalid', problem: 'unsupported-method' });
  });

  it('refuses a damaged or cut-off signature block', async () => {
    const plain = await zip();
    expect(await check(withBlock(plain, Buffer.from('not a signature')))).toEqual({ status: 'invalid', problem: 'damaged' });
    expect(await check(Buffer.concat([plain, Buffer.from('MCPB_SIG_END')]))).toEqual({ status: 'invalid', problem: 'damaged' });
    const signed = signBundle(plain, leaf, { chain: [signingCa] });
    const block = signed.subarray(plain.length);
    expect(await check(withBlock(plain, block.subarray(15, block.length - 40)))).toEqual({ status: 'invalid', problem: 'damaged' });
  });
});

describe('no trusted signature', () => {
  it('calls a bundle without a block unsigned', async () => {
    const plain = await zip();
    expect(splitMcpbSignature(plain)).toEqual({ content: plain, damaged: false });
    expect(await check(plain)).toEqual({ status: 'unsigned' });
  });

  it('calls a sound signature unsigned when its authority is unknown or a link is missing', async () => {
    expect(await check(signBundle(await zip(), leaf, { chain: [signingCa] }), [])).toMatchObject({ status: 'unsigned', signer: { name: 'Ada Example' } });
    expect((await check(signBundle(await zip(), leaf))).status).toBe('unsigned');

    const notCa = makeCertificate({ commonName: 'Not a CA', issuer: root });
    const underNotCa = makeCertificate({ commonName: 'Under Not a CA', issuer: notCa, extendedKeyUsage: [OIDS.codeSigning] });
    expect((await check(signBundle(await zip(), underNotCa, { chain: [notCa] }))).status).toBe('unsigned');
  });
});

it('reads the computer\'s trusted authorities in the background, once', async () => {
  const first = await systemTrustedRoots();
  expect(Array.isArray(first)).toBe(true);
  expect(first.every((certificate) => certificate instanceof X509Certificate)).toBe(true);
  expect(await systemTrustedRoots()).toBe(first);
});

it('also trusts the authorities given to Node in NODE_EXTRA_CA_CERTS', async () => {
  const rootFile = path.join(FIXTURES, 'test-root-ca.pem');
  const readInWorker = `
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(process.argv[1], { eval: true });
    worker.once('message', (pems) => { process.stdout.write(JSON.stringify(pems)); void worker.terminate(); });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', readInWorker, TRUSTED_ROOTS_WORKER_SOURCE], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: rootFile },
  });
  const fingerprints = (JSON.parse(stdout) as string[]).map((pem) => new X509Certificate(pem).fingerprint256);
  expect(fingerprints).toContain(new X509Certificate(await fs.readFile(rootFile)).fingerprint256);
});
