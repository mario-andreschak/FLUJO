const store = new Map<string, unknown>();
const loadItemMock = jest.fn(async (key: string, fallback: unknown) =>
  store.has(key) ? store.get(key) : fallback
);
const saveItemMock = jest.fn(async (key: string, value: unknown) => {
  store.set(key, structuredClone(value));
});
const randomUUIDMock = jest.fn();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...(args as [string, unknown])),
  saveItem: (...args: unknown[]) => saveItemMock(...(args as [string, unknown])),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: () => randomUUIDMock(),
}));

jest.mock('@/utils/paths', () => ({
  getInstallMode: () => 'git',
}));

import { StorageKey } from '@/shared/types/storage';
import {
  _resetTelemetrySingleFlight,
  checkDailyActivity,
  fetchDailyActivityCount,
  resolveTelemetryUrl,
} from '@/backend/services/telemetry';
import { DEFAULT_REGISTRY_URL } from '@/shared/types/registry';

describe('anonymous daily activity telemetry', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.FLUJO_TELEMETRY_URL;

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    _resetTelemetrySingleFlight();
    delete process.env.FLUJO_TELEMETRY_URL;
    randomUUIDMock
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{}', { status: 202 }),
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.FLUJO_TELEMETRY_URL;
    else process.env.FLUJO_TELEMETRY_URL = originalUrl;
  });

  it('is opt-out and sends only the allowlisted payload once per UTC day', async () => {
    const first = await checkDailyActivity(
      new Date('2026-07-29T12:00:00.000Z'),
    );
    const second = await checkDailyActivity(
      new Date('2026-07-29T20:00:00.000Z'),
    );

    expect(first).toEqual({
      enabled: true,
      attempted: true,
      sent: true,
      shouldNotify: true,
    });
    expect(second).toEqual({
      enabled: true,
      attempted: false,
      sent: true,
      shouldNotify: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const payload = JSON.parse(options.body);
    expect(payload).toEqual({
      anonymousDailyId: '11111111-1111-4111-8111-111111111111',
      date: '2026-07-29',
      version: expect.any(String),
      platform: process.platform,
      installMethod: 'git',
    });
  });

  it('rotates the anonymous id on the next UTC day', async () => {
    await checkDailyActivity(new Date('2026-07-29T23:59:59.000Z'));
    await checkDailyActivity(new Date('2026-07-30T00:00:01.000Z'));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const second = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(first.anonymousDailyId).not.toBe(second.anonymousDailyId);
    expect(second.date).toBe('2026-07-30');
  });

  it('performs no network request after the user opts out', async () => {
    store.set(StorageKey.SPEECH_SETTINGS, {
      speech: { enabled: true },
      telemetry: { enabled: false, notifyDaily: true },
    });

    await expect(
      checkDailyActivity(new Date('2026-07-29T12:00:00.000Z')),
    ).resolves.toEqual({
      enabled: false,
      attempted: false,
      sent: false,
      shouldNotify: false,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps sharing while honoring "don’t notify again"', async () => {
    store.set(StorageKey.SPEECH_SETTINGS, {
      speech: { enabled: true },
      telemetry: { enabled: true, notifyDaily: false },
    });

    const result = await checkDailyActivity(
      new Date('2026-07-29T12:00:00.000Z'),
    );
    expect(result).toMatchObject({
      attempted: true,
      sent: true,
      shouldNotify: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('supports a self-hosted collector URL', () => {
    process.env.FLUJO_TELEMETRY_URL = 'https://metrics.example.test/pulse';
    expect(resolveTelemetryUrl()).toBe('https://metrics.example.test/pulse');
    delete process.env.FLUJO_TELEMETRY_URL;
    expect(resolveTelemetryUrl()).toBe(
      `${DEFAULT_REGISTRY_URL}/v1/telemetry/daily-active`,
    );
  });

  it('reads a validated daily-active aggregate from the collector', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ date: '2026-07-29', count: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchDailyActivityCount('2026-07-29')).resolves.toEqual({
      date: '2026-07-29',
      count: 42,
    });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('date=2026-07-29');
    expect(options.method).toBeUndefined();
  });

  it('rejects malformed daily-active aggregates', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ date: '2026-07-29', count: -1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchDailyActivityCount('2026-07-29')).resolves.toBeNull();
  });
});
