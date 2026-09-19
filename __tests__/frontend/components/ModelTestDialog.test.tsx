import React from 'react';
import { render, screen } from '@testing-library/react';
import ModelTestDialog from '@/frontend/components/models/list/ModelTestDialog';
import type { ModelTestResult } from '@/shared/types/model/response';

jest.mock('@/frontend/components/AskFlujo/AskFlujoButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({ __esModule: true, default: () => null }));

const baseResult: ModelTestResult = {
  ok: true,
  model: 'test/model',
  provider: 'requesty',
  sdk: { ok: true, durationMs: 10, content: 'pong' },
  axios: { ok: true, durationMs: 10, content: 'pong' },
  adapterRoute: { adapterId: 'openai-responses', endpoint: '/responses', reason: 'Gateway Responses API' },
  diagnosis: 'Connected successfully.',
};

function showResult(result: ModelTestResult) {
  render(<ModelTestDialog open modelLabel="Test model" loading={false} result={result} error={null} onClose={jest.fn()} onRetry={jest.fn()} />);
}

it('shows tool failure independently of successful SDK and axios checks', () => {
  showResult({
    ...baseResult,
    ok: false,
    diagnosis: 'The FLUJO tool round-trip failed.',
    tool: { ok: false, durationMs: 20, error: { message: 'The model did not call the tool.', code: 'tool_test_call_failed' } },
  });
  expect(screen.getByText('FLUJO tool round-trip')).toBeInTheDocument();
  expect(screen.getByText('The model did not call the tool.')).toBeInTheDocument();
  expect(screen.getByText(/tool_test_call_failed/)).toBeInTheDocument();
  expect(screen.getByText('Endpoint: /responses')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveClass('MuiAlert-standardWarning');
});

it('labels an unavailable tool test as skipped and explains why', () => {
  showResult({
    ...baseResult,
    tool: { ok: false, skipped: true, durationMs: 0, content: 'Dedicated media model; tool test unavailable.' },
  });
  expect(screen.getByText('Skipped')).toBeInTheDocument();
  expect(screen.getByText('Dedicated media model; tool test unavailable.')).toBeInTheDocument();
});
