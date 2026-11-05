import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { isManagedInstall, updateCheckOff, usageReportingOff } from '@/utils/managedInstall';

describe('settings', () => {
  it('ordinary installations change nothing', () => {
    expect(isManagedInstall({})).toBe(false);
    expect(usageReportingOff({})).toBe(false);
    expect(updateCheckOff({})).toBe(false);
    expect(usageReportingOff({ FLUJO_MANAGED: '0', FLUJO_TELEMETRY: 'on' })).toBe(false);
    expect(updateCheckOff({ FLUJO_MANAGED: 'off', FLUJO_UPDATE_CHECK: '1' })).toBe(false);
    expect(usageReportingOff({ FLUJO_TELEMETRY: 'maybe' })).toBe(false);
  });

  it.each(['1', 'true', 'YES', ' on '])('FLUJO_MANAGED=%p turns both off', value => {
    expect(usageReportingOff({ FLUJO_MANAGED: value })).toBe(true);
    expect(updateCheckOff({ FLUJO_MANAGED: value })).toBe(true);
  });

  it.each(['0', 'false', 'No', 'off'])('each has its own setting (%p)', value => {
    expect(usageReportingOff({ FLUJO_TELEMETRY: value })).toBe(true);
    expect(updateCheckOff({ FLUJO_TELEMETRY: value })).toBe(false);
    expect(updateCheckOff({ FLUJO_UPDATE_CHECK: value })).toBe(true);
    expect(usageReportingOff({ FLUJO_UPDATE_CHECK: value })).toBe(false);
  });
});

describe('nothing leaves the machine when reporting is off', () => {
  let tmp: string;
  const originalFetch = global.fetch;
  const fetchSpy = jest.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-managed-'));
    process.env.FLUJO_DATA_DIR = tmp;
    fetchSpy.mockClear();
    global.fetch = fetchSpy as unknown as typeof fetch;
    jest.resetModules();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.FLUJO_DATA_DIR;
    delete process.env.FLUJO_MANAGED;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('managed: no daily pulse, no count request, no notice', async () => {
    process.env.FLUJO_MANAGED = '1';
    const { checkDailyActivity, fetchDailyActivityCount } = await import('@/backend/services/telemetry');
    expect(await checkDailyActivity()).toEqual({ enabled: false, attempted: false, sent: false, shouldNotify: false });
    expect(await fetchDailyActivityCount()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ordinary: the pulse still goes out, to the documented place', async () => {
    const { checkDailyActivity } = await import('@/backend/services/telemetry');
    const result = await checkDailyActivity();
    expect(result.enabled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://registry.flujo.com.co/v1/telemetry/daily-active');
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(['anonymousDailyId', 'date', 'installMethod', 'platform', 'version']);
  });
});
