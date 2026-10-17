import { createHash, randomUUID } from 'node:crypto';

// uuid@14 is ESM-only. The application and production build consume it
// natively; expose the v4 and RFC 4122 v5 surfaces in Jest's CommonJS runtime.
export const v4 = (): string => randomUUID();

export const v5 = Object.assign((value: string, namespace: string): string => {
  const bytes = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(value, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}, { URL: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', DNS: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' });
