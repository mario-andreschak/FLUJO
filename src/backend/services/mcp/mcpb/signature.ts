/**
 * Checking the signature of an MCP bundle (#1230), as the official tool writes
 * it (`mcpb sign`, src/node/sign.ts in modelcontextprotocol/mcpb):
 *
 *   <zip bytes> "MCPB_SIG_V1" <4-byte little-endian length> <PKCS#7> "MCPB_SIG_END"
 *
 * The PKCS#7 (CMS, RFC 5652) signature is detached and signs the zip bytes as
 * they were before the block was added. The tool's main branch (after release
 * 2.1.2) also raises the zip's comment length by the block's size after
 * signing, so that value is put back before hashing; both forms are accepted.
 *
 * A signature counts as `signed` only when all of this holds: the hash in the
 * signature matches the file, the signature verifies with the certificate it
 * names, that certificate is valid today and may sign software, and it leads
 * to a certificate authority the operating system trusts. A signature that
 * fails any of the first four is `invalid` and the bundle is refused. A sound
 * signature from a certificate nobody trusted vouches for counts as unsigned,
 * because anyone can make such a certificate.
 *
 * Certificate revocation is not looked up online: that needs the network on
 * every install, tells the authority what is being installed, and fails open
 * everywhere it is used (browsers included).
 */
import {
  constants,
  createHash,
  createVerify,
  verify as verifySignature,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import type { McpbSignature, McpbSignatureProblem, McpbSigner } from '@/shared/types/mcp/mcpb';
import {
  certificateParts,
  DER,
  DerError,
  derChildren,
  derOid,
  derSmallInteger,
  expectTag,
  readDerExact,
  type CertificateParts,
  type DerNode,
} from './der';
import { systemTrustedRoots } from './trustedRoots';

const MIB = 1024 * 1024;
const HASH_CHUNK_BYTES = 8 * MIB;
const SIGNATURE_HEADER = Buffer.from('MCPB_SIG_V1', 'utf8');
const SIGNATURE_FOOTER = Buffer.from('MCPB_SIG_END', 'utf8');
const LENGTH_BYTES = 4;
const MAX_SIGNATURE_BYTES = 4 * MIB;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_BYTES = 22;
const EOCD_COMMENT_LENGTH_AT = 20;
const MAX_ZIP_COMMENT = 0xffff;
const MAX_CHAIN_DEPTH = 8;
const MAX_NAME_LENGTH = 200;

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  rsaPss: '1.2.840.113549.1.1.10',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  anyExtendedKeyUsage: '2.5.29.37.0',
} as const;

const DIGESTS: Readonly<Record<string, string>> = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
  '1.2.840.113549.1.1.1', // RSA, what `mcpb sign` writes
  '1.2.840.113549.1.1.11', // RSA with SHA-256
  '1.2.840.113549.1.1.12', // RSA with SHA-384
  '1.2.840.113549.1.1.13', // RSA with SHA-512
  OID.rsaPss,
  '1.2.840.10045.2.1', // EC key
  '1.2.840.10045.4.3.2', // ECDSA with SHA-256
  '1.2.840.10045.4.3.3', // ECDSA with SHA-384
  '1.2.840.10045.4.3.4', // ECDSA with SHA-512
  '1.3.101.112', // Ed25519
]);

/** Feed `parts` to `consume` in chunks, yielding between them so a big bundle never stalls the app. */
export async function feedInChunks(parts: readonly Buffer[], consume: (chunk: Buffer) => void): Promise<void> {
  let first = true;
  for (const part of parts) {
    for (let offset = 0; offset < part.length; offset += HASH_CHUNK_BYTES) {
      if (!first) await new Promise<void>((resolve) => setImmediate(resolve));
      first = false;
      consume(part.subarray(offset, offset + HASH_CHUNK_BYTES));
    }
  }
}

async function digestParts(parts: readonly Buffer[], algorithm: string): Promise<Buffer> {
  const hash = createHash(algorithm);
  await feedInChunks(parts, (chunk) => hash.update(chunk));
  return hash.digest();
}

export interface SplitMcpbSignature {
  /** The zip bytes before the signature block (all bytes when there is none). */
  content: Buffer;
  /** The PKCS#7 signature, when a complete block was found. */
  pkcs7?: Buffer;
  /** The file ends like a signature block, but the block is cut off or broken. */
  damaged: boolean;
}

/** Find the signature block at the end of the file. Reads nothing else. */
export function splitMcpbSignature(bytes: Buffer): SplitMcpbSignature {
  const footerAt = bytes.length - SIGNATURE_FOOTER.length;
  if (footerAt < 0 || !bytes.subarray(footerAt).equals(SIGNATURE_FOOTER)) return { content: bytes, damaged: false };
  const lowest = Math.max(0, footerAt - SIGNATURE_HEADER.length - LENGTH_BYTES - MAX_SIGNATURE_BYTES);
  for (let at = footerAt - SIGNATURE_HEADER.length - LENGTH_BYTES; at >= lowest; at--) {
    if (bytes[at] !== SIGNATURE_HEADER[0] || !bytes.subarray(at, at + SIGNATURE_HEADER.length).equals(SIGNATURE_HEADER)) continue;
    const lengthAt = at + SIGNATURE_HEADER.length;
    const length = bytes.readUInt32LE(lengthAt);
    if (length > 0 && lengthAt + LENGTH_BYTES + length === footerAt) {
      return { content: bytes.subarray(0, at), pkcs7: bytes.subarray(lengthAt + LENGTH_BYTES, footerAt), damaged: false };
    }
  }
  return { content: bytes, damaged: true };
}

/**
 * The bytes that were signed. Newer `mcpb sign` versions raise the zip's
 * comment length by the size of the signature block after signing; when the
 * comment length points at the end of the whole file, put the old value back.
 */
export function signedParts(bytes: Buffer, contentLength: number): Buffer[] {
  const content = bytes.subarray(0, contentLength);
  const blockLength = bytes.length - contentLength;
  const lowest = Math.max(0, contentLength - EOCD_BYTES - MAX_ZIP_COMMENT);
  for (let at = contentLength - EOCD_BYTES; at >= lowest; at--) {
    if (content[at] !== 0x50 || content.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    const commentLength = content.readUInt16LE(at + EOCD_COMMENT_LENGTH_AT);
    if (at + EOCD_BYTES + commentLength === contentLength) return [content];
    if (blockLength > 0 && at + EOCD_BYTES + commentLength === bytes.length) {
      const original = Buffer.alloc(2);
      original.writeUInt16LE(commentLength - blockLength);
      return [content.subarray(0, at + EOCD_COMMENT_LENGTH_AT), original, content.subarray(at + EOCD_COMMENT_LENGTH_AT + 2)];
    }
  }
  return [content];
}

type SignerId = { issuer: Buffer; serial: Buffer } | { keyId: Buffer };

interface SignedAttributes {
  /** The attributes as signed: the same bytes, tagged as a SET. */
  signedBytes: Buffer;
  contentTypeIsData: boolean;
  messageDigest?: Buffer;
}

interface ParsedSignature {
  certificates: CertificateParts[];
  signerId: SignerId;
  digestOid: string;
  signedAttributes?: SignedAttributes;
  signatureOid: string;
  signatureParameters?: DerNode;
  signature: Buffer;
}

function algorithmOid(node: DerNode | undefined): { oid: string; parameters?: DerNode } {
  const [oid, parameters] = derChildren(expectTag(node, DER.sequence));
  return { oid: derOid(oid), ...(parameters ? { parameters } : {}) };
}

function readSignedAttributes(node: DerNode): SignedAttributes {
  const signedBytes = Buffer.from(node.bytes);
  signedBytes[0] = DER.set;
  const seen = new Set<string>();
  let contentTypeIsData = false;
  let messageDigest: Buffer | undefined;
  for (const attribute of derChildren(node)) {
    const [type, values] = derChildren(expectTag(attribute, DER.sequence));
    const oid = derOid(type);
    if (oid !== OID.contentType && oid !== OID.messageDigest) continue;
    const items = derChildren(expectTag(values, DER.set));
    if (seen.has(oid) || items.length !== 1) throw new DerError('A signed attribute appears more than once.');
    seen.add(oid);
    if (oid === OID.contentType) contentTypeIsData = derOid(items[0]) === OID.data;
    else messageDigest = expectTag(items[0], DER.octetString).value;
  }
  return { signedBytes, contentTypeIsData, ...(messageDigest ? { messageDigest } : {}) };
}

function readSignerId(node: DerNode | undefined): SignerId {
  if (node?.tag === DER.sequence) {
    const [issuer, serial] = derChildren(node);
    return { issuer: expectTag(issuer, DER.sequence).bytes, serial: expectTag(serial, DER.integer).bytes };
  }
  return { keyId: expectTag(node, DER.implicit0).value };
}

/** Read the parts of a PKCS#7 SignedData that the check needs (the first signer only, like the official tool). */
function parseSignature(pkcs7: Buffer): ParsedSignature {
  const [contentType, wrapped] = derChildren(expectTag(readDerExact(pkcs7), DER.sequence));
  if (derOid(contentType) !== OID.signedData) throw new DerError('Not a SignedData signature.');
  const [signedData] = derChildren(expectTag(wrapped, DER.context0));
  const parts = derChildren(expectTag(signedData, DER.sequence));
  const certificateSet = parts.find((part) => part.tag === DER.context0);
  const certificates = certificateSet
    ? derChildren(certificateSet).filter((item) => item.tag === DER.sequence).map((item) => certificateParts(Buffer.from(item.bytes)))
    : [];
  const [firstSigner] = derChildren(expectTag(parts[parts.length - 1], DER.set));
  const fields = derChildren(expectTag(firstSigner, DER.sequence));
  let index = 1;
  const signerId = readSignerId(fields[index++]);
  const digest = algorithmOid(fields[index++]);
  const signedAttributes = fields[index]?.tag === DER.context0 ? readSignedAttributes(fields[index++]) : undefined;
  const signatureAlgorithm = algorithmOid(fields[index++]);
  const signature = expectTag(fields[index], DER.octetString).value;
  return {
    certificates,
    signerId,
    digestOid: digest.oid,
    ...(signedAttributes ? { signedAttributes } : {}),
    signatureOid: signatureAlgorithm.oid,
    ...(signatureAlgorithm.parameters ? { signatureParameters: signatureAlgorithm.parameters } : {}),
    signature,
  };
}

function findSigner(parsed: ParsedSignature): CertificateParts | undefined {
  const id = parsed.signerId;
  return parsed.certificates.find((certificate) => ('keyId' in id
    ? certificate.subjectKeyId?.equals(id.keyId) === true
    : certificate.issuer.equals(id.issuer) && certificate.serial.equals(id.serial)));
}

interface SignatureMethod {
  hash: string | null;
  pss?: { saltLength: number };
}

/** RSASSA-PSS parameters: the hash ([0], SHA-1 when left out) and the salt length ([2], 20 when left out). */
function pssMethod(parameters: DerNode | undefined): SignatureMethod | undefined {
  const fields = parameters?.tag === DER.sequence ? derChildren(parameters) : [];
  const hashField = fields.find((field) => field.tag === DER.context0);
  const saltField = fields.find((field) => field.tag === 0xa2);
  const hash = hashField ? DIGESTS[algorithmOid(derChildren(hashField)[0]).oid] : undefined;
  if (!hash) return undefined;
  return { hash, pss: { saltLength: saltField ? derSmallInteger(derChildren(saltField)[0]) : 20 } };
}

function signatureMethod(parsed: ParsedSignature, key: KeyObject): SignatureMethod | undefined {
  const digest = DIGESTS[parsed.digestOid];
  if (!digest || !SIGNATURE_ALGORITHMS.has(parsed.signatureOid)) return undefined;
  if (parsed.signatureOid === OID.rsaPss) return pssMethod(parsed.signatureParameters);
  const type = key.asymmetricKeyType;
  return { hash: type === 'ed25519' || type === 'ed448' ? null : digest };
}

async function signatureVerifies(parsed: ParsedSignature, key: KeyObject, method: SignatureMethod, content: readonly Buffer[]): Promise<boolean> {
  const keyInput = method.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: method.pss.saltLength } : key;
  try {
    if (parsed.signedAttributes) return verifySignature(method.hash, parsed.signedAttributes.signedBytes, keyInput, parsed.signature);
    if (method.hash === null) return verifySignature(null, Buffer.concat(content), keyInput, parsed.signature);
    const verifier = createVerify(method.hash);
    await feedInChunks(content, (chunk) => verifier.update(chunk));
    return verifier.verify(keyInput, parsed.signature);
  } catch {
    return false;
  }
}

function dateProblem(certificate: X509Certificate, now: Date): McpbSignatureProblem | undefined {
  if (now.getTime() < new Date(certificate.validFrom).getTime()) return 'not-yet-valid';
  if (now.getTime() > new Date(certificate.validTo).getTime()) return 'expired';
  return undefined;
}

/** A certificate without an extended key usage may sign anything; one with it must list code signing. */
function maySignCode(certificate: X509Certificate): boolean {
  const usages: readonly string[] | undefined = certificate.keyUsage;
  return !usages || usages.includes(OID.codeSigning) || usages.includes(OID.anyExtendedKeyUsage);
}

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
  try {
    return child.checkIssued(parent) && child.verify(parent.publicKey);
  } catch {
    return false;
  }
}

/** Follow the certificates in the signature up to one the computer trusts. */
function chainProblem(
  signer: X509Certificate,
  pool: readonly X509Certificate[],
  roots: readonly X509Certificate[],
  now: Date,
): 'trusted' | 'untrusted' | McpbSignatureProblem {
  const used = new Set<string>();
  let current = signer;
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
    if (roots.some((root) => root.raw.equals(current.raw))) return 'trusted';
    if (roots.some((root) => !dateProblem(root, now) && issuedBy(current, root))) return 'trusted';
    used.add(current.fingerprint256);
    const issuer = pool.find((candidate) => !used.has(candidate.fingerprint256) && issuedBy(current, candidate));
    if (!issuer || !issuer.ca) return 'untrusted';
    const problem = dateProblem(issuer, now) ?? (maySignCode(issuer) ? undefined : 'not-for-code-signing');
    if (problem) return problem;
    current = issuer;
  }
  return 'untrusted';
}

function nameField(distinguishedName: string, field: string): string | undefined {
  const prefix = `${field}=`;
  const line = distinguishedName.split('\n').reverse().find((part) => part.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().slice(0, MAX_NAME_LENGTH) || undefined : undefined;
}

function displayName(distinguishedName: string): string {
  return nameField(distinguishedName, 'CN') ?? nameField(distinguishedName, 'O') ?? (distinguishedName.replace(/\n/g, ', ').slice(0, MAX_NAME_LENGTH) || 'Unknown');
}

function describeSigner(certificate: X509Certificate): McpbSigner {
  const name = displayName(certificate.subject);
  const organization = nameField(certificate.subject, 'O');
  return {
    name,
    ...(organization && organization !== name ? { organization } : {}),
    issuer: displayName(certificate.issuer),
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    fingerprint: certificate.fingerprint256,
  };
}

function readCertificate(der: Buffer): X509Certificate | undefined {
  try {
    return new X509Certificate(der);
  } catch {
    return undefined;
  }
}

export interface SignatureCheckOptions {
  /** The moment the certificates must be valid at; now when left out. */
  now?: Date;
  /** The certificate authorities to trust; the operating system's when left out. */
  trustedRoots?: () => Promise<readonly X509Certificate[]>;
}

async function checkPkcs7(bytes: Buffer, split: SplitMcpbSignature & { pkcs7: Buffer }, options: SignatureCheckOptions): Promise<McpbSignature> {
  const parsed = parseSignature(split.pkcs7);
  const signerParts = findSigner(parsed);
  if (!signerParts) return { status: 'invalid', problem: parsed.certificates.length ? 'wrong-certificate' : 'damaged' };
  const signer = readCertificate(signerParts.der);
  if (!signer) return { status: 'invalid', problem: 'damaged' };
  const described = describeSigner(signer);
  const invalid = (problem: McpbSignatureProblem): McpbSignature => ({ status: 'invalid', problem, signer: described });

  const method = signatureMethod(parsed, signer.publicKey);
  const digest = DIGESTS[parsed.digestOid];
  if (!method || !digest) return invalid('unsupported-method');
  const content = signedParts(bytes, split.content.length);
  if (parsed.signedAttributes) {
    const { messageDigest, contentTypeIsData } = parsed.signedAttributes;
    if (!messageDigest || !contentTypeIsData) return invalid('damaged');
    if (!(await digestParts(content, digest)).equals(messageDigest)) return invalid('changed');
  }
  if (!(await signatureVerifies(parsed, signer.publicKey, method, content))) return invalid('wrong-certificate');

  const now = options.now ?? new Date();
  const dated = dateProblem(signer, now);
  if (dated) return invalid(dated);
  if (!maySignCode(signer)) return invalid('not-for-code-signing');

  const pool = parsed.certificates.filter((certificate) => certificate !== signerParts).flatMap((certificate) => readCertificate(certificate.der) ?? []);
  const roots = await (options.trustedRoots ?? systemTrustedRoots)();
  const chain = chainProblem(signer, pool, roots, now);
  if (chain === 'trusted') return { status: 'signed', signer: described };
  if (chain === 'untrusted') return { status: 'unsigned', signer: described };
  return invalid(chain);
}

/** Check the signature block found by {@link splitMcpbSignature}. */
export async function checkMcpbSignature(bytes: Buffer, split: SplitMcpbSignature, options: SignatureCheckOptions = {}): Promise<McpbSignature> {
  if (!split.pkcs7) return split.damaged ? { status: 'invalid', problem: 'damaged' } : { status: 'unsigned' };
  try {
    return await checkPkcs7(bytes, { ...split, pkcs7: split.pkcs7 }, options);
  } catch (error) {
    if (error instanceof DerError) return { status: 'invalid', problem: 'damaged' };
    throw error;
  }
}

/** Plain words for why a signature is refused, for errors the route sends. */
export function signatureProblemText(signature: McpbSignature): string {
  const until = signature.signer ? new Date(signature.signer.validTo).toISOString().slice(0, 10) : '';
  const from = signature.signer ? new Date(signature.signer.validFrom).toISOString().slice(0, 10) : '';
  switch (signature.problem) {
    case 'changed': return 'The bundle was changed after it was signed.';
    case 'wrong-certificate': return 'The signature was not made with the certificate that comes with it.';
    case 'expired': return `The certificate that signed it expired${until ? ` on ${until}` : ''}.`;
    case 'not-yet-valid': return `The certificate that signed it is not valid before ${from || 'a later date'}.`;
    case 'not-for-code-signing': return 'The certificate that signed it may not be used to sign software.';
    case 'unsupported-method': return 'It was signed with an outdated or unknown method.';
    default: return 'The signature is damaged.';
  }
}
