import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Fixed work factor: configuration and submitted hashes cannot choose memory/CPU.
// OWASP scrypt baseline: N=2^17, r=8, p=1. Only two web checks run concurrently.
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const encoded = /^scrypt-v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

export function passwordAllowed(password: string): boolean {
  return Array.from(password).length >= 15 && Buffer.byteLength(password, 'utf8') <= 1024
    && !/[\u0000-\u001f\u007f]/.test(password);
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  const bytes = Buffer.from(password, 'utf8');
  return new Promise((resolve, reject) => {
    scrypt(bytes, salt, 64, options, (error, key) => {
      bytes.fill(0);
      if (error) reject(new Error('Password verification unavailable.'));
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!passwordAllowed(password)) throw new Error('Use a password of at least 15 characters and at most 1024 UTF-8 bytes.');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  try { return `scrypt-v1$${salt.toString('base64url')}$${key.toString('base64url')}`; }
  finally { key.fill(0); }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = encoded.exec(stored);
  if (!match || !passwordAllowed(password)) return false;
  const key = await derive(password, Buffer.from(match[1], 'base64url'));
  try { return timingSafeEqual(key, Buffer.from(match[2], 'base64url')); }
  finally { key.fill(0); }
}
