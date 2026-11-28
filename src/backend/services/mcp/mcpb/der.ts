/**
 * A strict reader for DER, the byte format of certificates and PKCS#7
 * signatures (#1230). It only finds where each element starts and ends and
 * reads object identifiers; every signature, hash and certificate check runs
 * in Node's crypto. Anything that is not plain DER (long tags, open-ended
 * lengths, bytes past the end) throws {@link DerError}.
 */

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

export interface DerNode {
  /** The identifier byte: class, constructed bit and tag number. */
  tag: number;
  /** The whole element, header included. */
  bytes: Buffer;
  /** The element's content, without the header. */
  value: Buffer;
}

export const DER = {
  integer: 0x02,
  octetString: 0x04,
  oid: 0x06,
  sequence: 0x30,
  set: 0x31,
  context0: 0xa0,
  context1: 0xa1,
  context3: 0xa3,
  implicit0: 0x80,
} as const;

const CONSTRUCTED = 0x20;

/** Read the element that starts at `offset`. */
export function readDer(buffer: Buffer, offset = 0): DerNode {
  if (offset + 2 > buffer.length) throw new DerError('The data ends inside an element header.');
  const tag = buffer[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError('Long tag numbers are not used by signatures.');
  const first = buffer[offset + 1];
  let headerLength = 2;
  let length = first;
  if (first >= 0x80) {
    const count = first & 0x7f;
    if (count === 0) throw new DerError('Open-ended lengths are not DER.');
    if (count > 4) throw new DerError('The element is too long.');
    if (offset + 2 + count > buffer.length) throw new DerError('The data ends inside a length.');
    length = buffer.readUIntBE(offset + 2, count);
    headerLength += count;
  }
  const end = offset + headerLength + length;
  if (end > buffer.length) throw new DerError('An element runs past the end of the data.');
  return { tag, bytes: buffer.subarray(offset, end), value: buffer.subarray(offset + headerLength, end) };
}

/** Read `buffer` as exactly one element. */
export function readDerExact(buffer: Buffer): DerNode {
  const node = readDer(buffer);
  if (node.bytes.length !== buffer.length) throw new DerError('Extra bytes follow the element.');
  return node;
}

export function derChildren(node: DerNode): DerNode[] {
  if ((node.tag & CONSTRUCTED) === 0) throw new DerError('Expected an element that holds other elements.');
  const children: DerNode[] = [];
  for (let at = 0; at < node.value.length;) {
    const child = readDer(node.value, at);
    children.push(child);
    at += child.bytes.length;
  }
  return children;
}

export function expectTag(node: DerNode | undefined, tag: number): DerNode {
  if (!node || node.tag !== tag) throw new DerError(`Expected tag 0x${tag.toString(16)}.`);
  return node;
}

/** The dotted form of an object identifier, for example `1.2.840.113549.1.7.2`. */
export function derOid(node: DerNode | undefined): string {
  const { value } = expectTag(node, DER.oid);
  if (value.length === 0 || (value[value.length - 1] & 0x80) !== 0) throw new DerError('A broken object identifier.');
  const arcs: number[] = [];
  let arc = 0;
  for (const byte of value) {
    if (arc === 0 && byte === 0x80) throw new DerError('A padded object identifier.');
    arc = arc * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(arc)) throw new DerError('An object identifier part is too large.');
    if ((byte & 0x80) === 0) {
      if (arcs.length === 0) arcs.push(arc < 80 ? Math.floor(arc / 40) : 2, arc < 80 ? arc % 40 : arc - 80);
      else arcs.push(arc);
      arc = 0;
    }
  }
  return arcs.join('.');
}

/** A small non-negative INTEGER, such as a salt length. */
export function derSmallInteger(node: DerNode | undefined): number {
  const { value } = expectTag(node, DER.integer);
  if (value.length === 0 || value.length > 4 || (value[0] & 0x80) !== 0) throw new DerError('Expected a small positive number.');
  return value.readUIntBE(0, value.length);
}

/** The parts of an X.509 certificate needed to match a PKCS#7 signer to it. */
export interface CertificateParts {
  der: Buffer;
  /** The serial number element, header included. */
  serial: Buffer;
  /** The issuer and subject names, header included. */
  issuer: Buffer;
  subject: Buffer;
  subjectKeyId?: Buffer;
}

const SUBJECT_KEY_ID = '2.5.29.14';

export function certificateParts(der: Buffer): CertificateParts {
  const [tbs] = derChildren(expectTag(readDerExact(der), DER.sequence));
  const fields = derChildren(expectTag(tbs, DER.sequence));
  const start = fields[0]?.tag === DER.context0 ? 1 : 0;
  const serial = expectTag(fields[start], DER.integer);
  const issuer = expectTag(fields[start + 2], DER.sequence);
  const subject = expectTag(fields[start + 4], DER.sequence);
  let subjectKeyId: Buffer | undefined;
  const extensions = fields.find((field) => field.tag === DER.context3);
  if (extensions) {
    const [list] = derChildren(extensions);
    for (const extension of derChildren(expectTag(list, DER.sequence))) {
      const parts = derChildren(expectTag(extension, DER.sequence));
      if (derOid(parts[0]) !== SUBJECT_KEY_ID) continue;
      const wrapped = expectTag(parts[parts.length - 1], DER.octetString);
      subjectKeyId = expectTag(readDerExact(wrapped.value), DER.octetString).value;
    }
  }
  return { der, serial: serial.bytes, issuer: issuer.bytes, subject: subject.bytes, ...(subjectKeyId ? { subjectKeyId } : {}) };
}
