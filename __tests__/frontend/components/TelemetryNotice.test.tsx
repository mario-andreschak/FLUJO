import { act, render, screen } from '@testing-library/react';
import TelemetryNotice, { TELEMETRY_NOTICE_SECONDS } from '@/frontend/components/TelemetryNotice';

const mockUpdateSettings = jest.fn();
jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings }),
}));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

// On a phone the notice covers the lower half of the screen, where the page's main button often is (#572).
describe('daily activity sharing notice', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ enabled: true, attempted: true, sent: true, shouldNotify: true }),
    }) as unknown as typeof fetch;
  });
  afterEach(() => { jest.useRealTimers(); });

  it('tells the person, offers to turn sharing off, then gets out of the way on its own', async () => {
    render(<TelemetryNotice />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('telemetry.notice.sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'telemetry.notice.turnOff' })).toBeInTheDocument();

    await act(async () => { jest.advanceTimersByTime((TELEMETRY_NOTICE_SECONDS - 1) * 1000); });
    expect(screen.getByText('telemetry.notice.sent')).toBeInTheDocument();
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await act(async () => { jest.runOnlyPendingTimers(); });
    expect(screen.queryByText('telemetry.notice.sent')).not.toBeInTheDocument();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
});
