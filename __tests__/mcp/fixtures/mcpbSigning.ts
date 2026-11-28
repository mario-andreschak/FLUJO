/**
 * Test-only certificates and MCP bundle signatures (#1230). Builds X.509
 * certificates and PKCS#7 signatures byte by byte, the way `mcpb sign`
 * (modelcontextprotocol/mcpb, src/node/sign.ts) writes them, so each test can
 * make exactly the signature it needs: valid, tampered, wrong certificate,
 * expired, untrusted and so on.
 */
import { constants, createHash, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'crypto';

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...content: Buffer[]) => tlv(0x30, ...content);
const set = (...content: Buffer[]) => tlv(0x31, ...content);
const octets = (value: Buffer) => tlv(0x04, value);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'));
const explicit = (tagNumber: number, ...content: Buffer[]) => tlv(0xa0 + tagNumber, ...content);
const bitString = (value: Buffer) => tlv(0x03, Buffer.from([0]), value);
const nullValue = () => Buffer.from([0x05, 0x00]);

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const chunk = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(value: number): Buffer {
  const hex = value.toString(16);
  let bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function time(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${text.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${text}Z`));
}

export const OIDS = {
  codeSigning: '1.3.6.1.5.5.7.3.3',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
};

export type TestKeyType = 'ec' | 'rsa' | 'ed25519';

export interface TestCertificate {
  der: Buffer;
  pem: string;
  x509: X509Certificate;
  privateKey: KeyObject;
  keyType: TestKeyType;
  /** The subject, issuer and serial number elements, for the signer id. */
  subject: Buffer;
  issuerName: Buffer;
  serial: Buffer;
  keyId: Buffer;
}

function newKeys(keyType: TestKeyType) {
  if (keyType === 'rsa') return generateKeyPairSync('rsa', { modulusLength: 2048 });
  if (keyType === 'ed25519') return generateKeyPairSync('ed25519');
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function signatureAlgorithm(keyType: TestKeyType): Buffer {
  if (keyType === 'rsa') return seq(oid('1.2.840.113549.1.1.11'), nullValue());
  if (keyType === 'ed25519') return seq(oid('1.3.101.112'));
  return seq(oid('1.2.840.10045.4.3.2'));
}

function signWith(keyType: TestKeyType, key: KeyObject, data: Buffer, hash = 'sha256'): Buffer {
  return sign(keyType === 'ed25519' ? null : hash, data, key);
}

let nextSerial = 0x1000;
const DAY = 24 * 60 * 60 * 1000;

export interface CertificateOptions {
  commonName: string;
  organization?: string;
  /** Leave out for a self-signed certificate. */
  issuer?: TestCertificate;
  notBefore?: Date;
  notAfter?: Date;
  ca?: boolean;
  /** Extended key usages; left out means none (may sign anything). */
  extendedKeyUsage?: string[];
  keyType?: TestKeyType;
}

export function makeCertificate(options: CertificateOptions): TestCertificate {
  const keyType = options.keyType ?? 'ec';
  const { publicKey, privateKey } = newKeys(keyType);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha1').update(spki).digest();
  const subject = seq(
    ...(options.organization ? [set(seq(oid('2.5.4.10'), utf8(options.organization)))] : []),
    set(seq(oid('2.5.4.3'), utf8(options.commonName))),
  );
  const serial = integer(nextSerial++);
  const signerType = options.issuer?.keyType ?? keyType;
  const extensions = [
    seq(oid('2.5.29.19'), Buffer.from([0x01, 0x01, 0xff]), octets(seq(...(options.ca ? [Buffer.from([0x01, 0x01, 0xff])] : [])))),
    seq(oid('2.5.29.14'), octets(octets(keyId))),
    ...(options.extendedKeyUsage ? [seq(oid('2.5.29.37'), octets(seq(...options.extendedKeyUsage.map(oid))))] : []),
  ];
  const now = Date.now();
  const tbs = seq(
    explicit(0, integer(2)),
    serial,
    signatureAlgorithm(signerType),
    options.issuer?.subject ?? subject,
    seq(time(options.notBefore ?? new Date(now - DAY)), time(options.notAfter ?? new Date(now + 365 * DAY))),
    subject,
    spki,
    explicit(3, seq(...extensions)),
  );
  const der = seq(tbs, signatureAlgorithm(signerType), bitString(signWith(signerType, options.issuer?.privateKey ?? privateKey, tbs)));
  const x509 = new X509Certificate(der);
  return { der, pem: x509.toString(), x509, privateKey, keyType, subject, issuerName: options.issuer?.subject ?? subject, serial, keyId };
}

const SIGNATURE_HEADER = Buffer.from('MCPB_SIG_V1');
const SIGNATURE_FOOTER = Buffer.from('MCPB_SIG_END');

export interface SignOptions {
  /** Further certificates to carry, such as an intermediate. */
  chain?: TestCertificate[];
  /** Sign with this key instead of the signer's own (a wrong certificate). */
  signingKey?: { keyType: TestKeyType; privateKey: KeyObject };
  digestOid?: string;
  /** Name the signer by its key id instead of issuer and serial. */
  byKeyId?: boolean;
  /** Leave out the signed attributes and sign the bundle bytes directly. */
  withoutAttributes?: boolean;
  /** Write the zip comment length as mcpb releases up to 2.1.2 do (unchanged). */
  keepCommentLength?: boolean;
  /** Sign an RSA key with RSASSA-PSS (SHA-256, 32-byte salt) instead of PKCS#1 v1.5. */
  pss?: boolean;
}

const PSS_SALT_LENGTH = 32;

function pssAlgorithm(): Buffer {
  const sha256 = seq(oid(OIDS.sha256));
  return seq(oid('1.2.840.113549.1.1.10'), seq(
    explicit(0, sha256),
    explicit(1, seq(oid('1.2.840.113549.1.1.8'), sha256)),
    explicit(2, integer(PSS_SALT_LENGTH)),
  ));
}

/** Sign `zip` the way `mcpb sign` does: a detached PKCS#7 appended in an MCPB_SIG_V1 block. */
export function signBundle(zip: Buffer, signer: TestCertificate, options: SignOptions = {}): Buffer {
  const digestOid = options.digestOid ?? OIDS.sha256;
  const hash = digestOid === OIDS.sha1 ? 'sha1' : 'sha256';
  const key = options.signingKey ?? signer;
  const attributes = set(
    seq(oid('1.2.840.113549.1.9.3'), set(oid('1.2.840.113549.1.7.1'))),
    seq(oid('1.2.840.113549.1.9.5'), set(time(new Date()))),
    seq(oid('1.2.840.113549.1.9.4'), set(octets(createHash(hash).update(zip).digest()))),
  );
  const signedAttributes = Buffer.from(attributes);
  signedAttributes[0] = 0xa0;
  const signed = options.withoutAttributes ? zip : attributes;
  const signature = options.pss
    ? sign(hash, signed, { key: key.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: PSS_SALT_LENGTH })
    : signWith(key.keyType, key.privateKey, signed, hash);
  const signerId = options.byKeyId ? tlv(0x80, signer.keyId) : seq(signer.issuerName, signer.serial);
  const signerInfo = seq(
    integer(options.byKeyId ? 3 : 1),
    signerId,
    seq(oid(digestOid)),
    ...(options.withoutAttributes ? [] : [signedAttributes]),
    options.pss ? pssAlgorithm() : signer.keyType === 'rsa' ? seq(oid(OIDS.rsaEncryption), nullValue()) : signatureAlgorithm(signer.keyType),
    octets(signature),
  );
  const signedData = seq(
    integer(1),
    set(seq(oid(digestOid))),
    seq(oid('1.2.840.113549.1.7.1')),
    tlv(0xa0, signer.der, ...(options.chain ?? []).map((certificate) => certificate.der)),
    set(signerInfo),
  );
  const pkcs7 = seq(oid('1.2.840.113549.1.7.2'), explicit(0, signedData));
  const sizeField = Buffer.alloc(4);
  sizeField.writeUInt32LE(pkcs7.length);
  const block = Buffer.concat([SIGNATURE_HEADER, sizeField, pkcs7, SIGNATURE_FOOTER]);
  const content = Buffer.from(zip);
  if (!options.keepCommentLength) {
    for (let at = content.length - 22; at >= 0; at--) {
      if (content.readUInt32LE(at) !== 0x06054b50) continue;
      content.writeUInt16LE(content.readUInt16LE(at + 20) + block.length, at + 20);
      break;
    }
  }
  return Buffer.concat([content, block]);
}

