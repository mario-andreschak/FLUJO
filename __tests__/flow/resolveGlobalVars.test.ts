const mockDebug = jest.fn();
const mockVerbose = jest.fn();
const mockWarn = jest.fn();
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  debug: (...args: unknown[]) => mockDebug(...args),
  verbose: (...args: unknown[]) => mockVerbose(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
  error: jest.fn(),
}) }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/utils/encryption/secure', () => ({ decryptWithPassword: jest.fn() }));

import { loadItem } from '@/utils/storage/backend';
import { decryptWithPassword } from '@/utils/encryption/secure';
import { resolveAndDecryptApiKey, resolveGlobalVars, resolveNonSecretGlobalVars } from '@/backend/utils/resolveGlobalVars';

describe('global variable data-key and secret boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadItem as jest.Mock).mockResolvedValue({ PUBLIC: 'public-value' });
    (decryptWithPassword as jest.Mock).mockResolvedValue('secret-value-witness');
  });

  it('preserves own prototype-like keys recursively through interpolation', async () => {
    const input = JSON.parse('{"__proto__":{"payload":"${global:PUBLIC}"},"constructor":"${global:PUBLIC}","nested":[{"__proto__":"${global:PUBLIC}"}]}');
    const result = await resolveGlobalVars(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result['__proto__']).toEqual({ payload: 'public-value' });
    expect(result.constructor).toBe('public-value');
    const child = (result.nested as Record<string, unknown>[])[0];
    expect(Object.getPrototypeOf(child)).toBe(Object.prototype);
    expect(Object.hasOwn(child, '__proto__')).toBe(true);
    expect(child['__proto__']).toBe('public-value');
  });

  it('keeps undeclared inherited names unresolved', async () => {
    (loadItem as jest.Mock).mockResolvedValue({});
    const input = '${global:constructor} ${global:toString} ${global:__proto__}';
    await expect(resolveGlobalVars(input)).resolves.toBe(input);
  });

  it.each(['legacy', 'metadata'])('supports explicitly declared special global names in %s records', async format => {
    const entries = ['__proto__', 'constructor', 'toString'].map(name => [name,
      format === 'legacy' ? `value-${name}` : { value: `value-${name}`, metadata: { isSecret: false } },
    ]);
    (loadItem as jest.Mock).mockResolvedValue(Object.fromEntries(entries));
    await expect(resolveGlobalVars('${global:__proto__}/${global:constructor}/${global:toString}'))
      .resolves.toBe('value-__proto__/value-constructor/value-toString');
  });

  it('retains secret projection policy without logging resolved secret values', async () => {
    (loadItem as jest.Mock).mockResolvedValue({ TOKEN: { value: 'encrypted:ciphertext', metadata: { isSecret: true } } });
    await expect(resolveNonSecretGlobalVars({ token: '${global:TOKEN}' })).resolves.toEqual({ token: '${global:TOKEN}' });
    expect(decryptWithPassword).not.toHaveBeenCalled();
    await expect(resolveGlobalVars({ token: '${global:TOKEN}' })).resolves.toEqual({ token: 'secret-value-witness' });
    await expect(resolveAndDecryptApiKey('encrypted:ciphertext')).resolves.toBe('secret-value-witness');
    expect(JSON.stringify([...mockDebug.mock.calls, ...mockVerbose.mock.calls, ...mockWarn.mock.calls]))
      .not.toContain('secret-value-witness');
  });
});
