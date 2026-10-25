import { isIP } from 'node:net';

export const CHAT_RATE_LIMITS = Object.freeze({ requests: 6000, windowMs: 60_000, keys: 4096, keyBytes: 1024 * 1024, headerCharacters: 1024 });
interface Entry { count: number; expires: number; bytes: number }
interface Runtime { entries: Map<string, Entry>; bytes: number; capacityRefusals: number; rateRefusals: number; expired: number }
const host = globalThis as typeof globalThis & { __flujoChatRateV1?: Runtime };
const runtime = host.__flujoChatRateV1 ??= { entries: new Map(), bytes: 0, capacityRefusals: 0, rateRefusals: 0, expired: 0 };

/** Bounded header work, normalized first IP only. Invalid/spoofed text shares
 * one quota rather than supplying arbitrary process-lifetime keys.
 */
export function canonicalChatIp(header: string | null): string {
  if (!header) return 'unknown';
  if (header.length > CHAT_RATE_LIMITS.headerCharacters) return 'invalid';
  const comma = header.indexOf(',');
  let ip = (comma < 0 ? header : header.slice(0, comma)).trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6 && !ip.includes('%')) {
    // The URL parser canonicalizes equivalent IPv6 spellings without DNS.
    const canonical = new URL(`http://[${ip}]/`).hostname;
    const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(canonical);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
    return canonical;
  }
  return 'invalid';
}
export function checkChatRateLimit(header: string | null, now = Date.now()): 'allowed' | 'rate' | 'capacity' {
  // Full sweeps are bounded by the hard 4096-entry ceiling. No timers, queues,
  // or eviction of a still-active quota, including at the capacity boundary.
  for (const [key, entry] of runtime.entries) {
    if (entry.expires <= now) { runtime.entries.delete(key); runtime.bytes -= entry.bytes; runtime.expired++; }
  }
  const key = canonicalChatIp(header);
  const entry = runtime.entries.get(key);
  if (entry) {
    if (entry.count >= CHAT_RATE_LIMITS.requests) { runtime.rateRefusals++; return 'rate'; }
    entry.count++; return 'allowed';
  }
  const bytes = 96 + key.length * 2;
  if (runtime.entries.size >= CHAT_RATE_LIMITS.keys || runtime.bytes + bytes > CHAT_RATE_LIMITS.keyBytes) {
    runtime.capacityRefusals++; return 'capacity';
  }
  runtime.entries.set(key, { count: 1, expires: Math.floor(now / CHAT_RATE_LIMITS.windowMs) * CHAT_RATE_LIMITS.windowMs + CHAT_RATE_LIMITS.windowMs, bytes });
  runtime.bytes += bytes;
  return 'allowed';
}
export function getChatRateDiagnostics() {
  return Object.freeze({ keys: runtime.entries.size, keyBytes: runtime.bytes, capacityRefusals: runtime.capacityRefusals,
    rateRefusals: runtime.rateRefusals, expired: runtime.expired, maxKeys: CHAT_RATE_LIMITS.keys, maxKeyBytes: CHAT_RATE_LIMITS.keyBytes });
}
