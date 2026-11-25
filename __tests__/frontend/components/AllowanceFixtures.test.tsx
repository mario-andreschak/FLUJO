import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AllowanceBar from '@/frontend/components/shared/AllowanceBar';
import { AllowanceProvider } from '@/frontend/contexts/AllowanceContext';
import { translate } from '@/frontend/i18n/core';
import { allowanceAccountKey, allowanceRefreshFailure, readAllowanceSnapshot } from '@/backend/services/model/allowance/store';
import { applyAllowanceFailure, projectModelAllowance } from '@/backend/services/model/allowance/projection';
import type { WorkspaceAllowance } from '@/shared/types/model/allowance';
import type { Model } from '@/shared/types/model/model';
import { claudeAllowanceFixtures, recordClaudeFixture, FIXTURE_SONNET } from '../../model/fixtures/claudeAllowanceFixtures';

jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => 'allowance-fixture-workspace' }));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({
  t: (key: never, values?: Record<string, string | number>) => translate('en', key, values),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', options).format(value),
  formatDate: (value: string, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(new Date(value)), locale: 'en',
}) }));

const fetchMock = jest.fn();
const originalFetch = global.fetch;
beforeEach(() => { fetchMock.mockReset(); global.fetch = fetchMock; });
afterEach(() => { global.fetch = originalFetch; });

const now = Date.now();

/** Fixture answer → account store → the projection GET /api/model/allowance returns → the bar. */
describe.each(claudeAllowanceFixtures(now).map(fixture => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
  test(`shows "${fixture.shows.text}"${fixture.shows.bar ? ` with a ${fixture.shows.bar.colour} bar` : ' and no bar'}`, async () => {
    const accountKey = allowanceAccountKey('claude', 'fixture:' + fixture.name);
    recordClaudeFixture(fixture, accountKey, now);
    const row = applyAllowanceFailure(projectModelAllowance(FIXTURE_SONNET as Model, accountKey, readAllowanceSnapshot(accountKey, now), now),
      allowanceRefreshFailure(accountKey));
    const snapshot: WorkspaceAllowance = { models: [row], observedAt: new Date(now).toISOString() };
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => structuredClone(snapshot) }));
    render(<AllowanceProvider><AllowanceBar modelIds={[FIXTURE_SONNET.id]} /></AllowanceProvider>);
    await screen.findByText(fixture.shows.text);
    // Never a made-up 0% or 100% when the reading is missing, refused or old.
    await waitFor(() => expect(screen.queryByText('Checking…')).not.toBeInTheDocument());
    expect(screen.getByText(fixture.shows.text)).toBeInTheDocument();
    if (fixture.shows.bar) {
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', String(fixture.shows.bar.percent));
      expect(bar.className).toContain('MuiLinearProgress-color' + fixture.shows.bar.colour[0].toUpperCase() + fixture.shows.bar.colour.slice(1));
    } else {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    }
    if (fixture.shows.detail) {
      if (!screen.queryByText(new RegExp(fixture.shows.detail))) fireEvent.click(screen.getByRole('button', { name: /Subscription allowance/ }));
      expect(screen.getByText(new RegExp(fixture.shows.detail))).toBeInTheDocument();
    }
  });
});
