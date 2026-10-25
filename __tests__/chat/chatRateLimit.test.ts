import { canonicalChatIp, CHAT_RATE_LIMITS, checkChatRateLimit, getChatRateDiagnostics } from '@/utils/http/chatRateLimit';

it('canonicalizes bounded first IPv4/IPv6 values and shares invalid input quota', () => {
  expect(canonicalChatIp(' 127.0.0.1, arbitrary-private-text')).toBe('127.0.0.1');
  expect(canonicalChatIp('2001:0DB8:0:0:0:0:0:1')).toBe(canonicalChatIp('[2001:db8::1]'));
  expect(canonicalChatIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
  expect(canonicalChatIp('x'.repeat(1025))).toBe('invalid');
  expect(canonicalChatIp('private-text')).toBe('invalid');
});

it('caps a unique IP flood, never evicts active abusive quotas, and actually removes expired entries', () => {
  const now = 120_000;
  for (let index = 0; index < CHAT_RATE_LIMITS.requests; index++) expect(checkChatRateLimit('10.0.0.1', now)).toBe('allowed');
  expect(checkChatRateLimit('10.0.0.1', now)).toBe('rate');
  for (let index = 1; index < CHAT_RATE_LIMITS.keys; index++) {
    expect(checkChatRateLimit(`2001:db8::${index.toString(16)}`, now)).toBe('allowed');
  }
  expect(checkChatRateLimit('10.0.0.2', now)).toBe('capacity');
  expect(checkChatRateLimit('10.0.0.1', now)).toBe('rate');
  const full = getChatRateDiagnostics();
  expect(full.keys).toBe(CHAT_RATE_LIMITS.keys); expect(full.keyBytes).toBeLessThanOrEqual(CHAT_RATE_LIMITS.keyBytes);
  expect(checkChatRateLimit('10.0.0.2', now + CHAT_RATE_LIMITS.windowMs)).toBe('allowed');
  expect(getChatRateDiagnostics()).toMatchObject({ keys: 1, expired: CHAT_RATE_LIMITS.keys });
});
