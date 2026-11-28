// A throwaway self-signed HTTPS certificate for one host name, made with Node alone, so the
// front door check runs over HTTPS like a real signed-in gateway without openssl or a download.
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const explicit = (number, inner) => tlv(0xa0 | number, inner);
const octets = (bytes) => tlv(0x04, bytes);
const bits = (bytes) => tlv(0x03, Buffer.from([0]), bytes);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
// UTCTime YYMMDDHHMMSSZ, valid until 2049.
const utcTime = (date) => tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));

function integer(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  return tlv(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function objectId(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const chunk = [];
    let remaining = value;
    do {
      chunk.unshift(remaining & 0x7f);
      remaining = Math.floor(remaining / 128);
    } while (remaining > 0);
    for (let index = 0; index < chunk.length - 1; index += 1) chunk[index] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const SUBJECT_ALT_NAME = '2.5.29.17';
const BASIC_CONSTRAINTS = '2.5.29.19';

/** A P-256 certificate for `hostname`, valid from a minute ago for `days` days. Returns PEM text. */
export function selfSignedCertificate(hostname, { days = 2, now = Date.now() } = {}) {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname)) throw new Error(`"${hostname}" is not a host name.`);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(objectId(ECDSA_WITH_SHA256));
  const name = sequence(set(sequence(objectId(COMMON_NAME), utf8(hostname))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const certificateBody = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + days * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(
      sequence(objectId(SUBJECT_ALT_NAME), octets(sequence(tlv(0x82, Buffer.from(hostname, 'ascii'))))),
      sequence(objectId(BASIC_CONSTRAINTS), octets(sequence())),
    )),
  );
  const signature = createSign('sha256').update(certificateBody).sign(privateKey);
  const der = sequence(certificateBody, algorithm, bits(signature));
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
