import { getExposureMode, inferLegacyExposureMode } from '@/utils/http/exposureMode';
import { isLocalRequest, isRequestHostAllowed } from '@/utils/http/localRequest';

const KEYS = [
  'FLUJO_EXPOSURE_MODE',
  'FLUJO_EXPOSURE_MODE_SOURCE',
  'FLUJO_RUNTIME_LOCAL_HOSTS',
  'FLUJO_EXTRA_LOCAL_HOSTS',
  'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL',
  'FLUJO_MCP_APP_HOST_ORIGINS',
] as const;
const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('single network exposure mode', () => {
  it('defaults to localhost and fails closed for other hosts', () => {
    expect(getExposureMode()).toBe('localhost');
    expect(isLocalRequest('localhost:4200', null)).toBe(true);
    expect(isLocalRequest('[::1]:4200', 'http://[::1]:4200')).toBe(true);
    expect(isLocalRequest('192.168.1.20:4200', null)).toBe(false);
    expect(isRequestHostAllowed('example.com')).toBe(false);
  });

  it('accepts private addresses and startup-discovered names in network mode', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'network';
    process.env.FLUJO_RUNTIME_LOCAL_HOSTS = 'workstation,10.0.0.8';

    expect(isLocalRequest('192.168.1.20:4200', null)).toBe(true);
    expect(isLocalRequest('workstation:4200', 'http://workstation:4200')).toBe(true);
    expect(isLocalRequest('192.168.1.20:4200', 'http://192.168.1.21:4200')).toBe(false);
    expect(isLocalRequest('printer.local:4200', null)).toBe(true);
    expect(isLocalRequest('example.com:4200', null)).toBe(false);
  });

  it('allows public native/same-host requests but rejects cross-site browser origins', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';

    expect(isLocalRequest('flujo.example.com', null)).toBe(true);
    expect(isLocalRequest('flujo.example.com', 'https://flujo.example.com')).toBe(true);
    expect(isLocalRequest('flujo.example.com', 'https://attacker.example')).toBe(false);
  });

  it('uses legacy host/sandbox variables only as migration inputs', () => {
    expect(inferLegacyExposureMode({ FLUJO_EXTRA_LOCAL_HOSTS: '.tenants.internal' })).toBe('network');
    expect(inferLegacyExposureMode({ FLUJO_EXTRA_LOCAL_HOSTS: ' , ' })).toBeUndefined();
    expect(inferLegacyExposureMode({ FLUJO_MCP_APP_SANDBOX_PUBLIC_URL: 'https://apps.example' })).toBe('public');
  });

  it('lets an explicit Settings choice supersede leftover legacy variables', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    process.env.FLUJO_EXPOSURE_MODE_SOURCE = 'settings';
    process.env.FLUJO_EXTRA_LOCAL_HOSTS = '.tenants.internal';

    expect(isLocalRequest('box.tenants.internal:4200', null)).toBe(false);
  });
});
