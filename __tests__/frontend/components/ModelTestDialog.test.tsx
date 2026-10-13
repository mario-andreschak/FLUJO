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

it('identifies the Antigravity CLI transport used by saved connections', () => {
  showResult({
    ...baseResult, provider: 'antigravity-cli',
    adapterRoute: { adapterId: 'antigravity-cli', endpoint: 'local CLI', reason: 'Official Antigravity CLI' },
    axios: { ok: false, skipped: true, durationMs: 0, content: 'CLI transport.' },
  });
  expect(screen.getByText('Antigravity CLI (used by flows)')).toBeInTheDocument();
  expect(screen.getByText('Endpoint: local CLI')).toBeInTheDocument();
  expect(screen.queryByText('OpenAI SDK')).not.toBeInTheDocument();
});

it.each(['claude-cli', 'anthropic', 'gemini', 'azure', 'openrouter-media'])('labels the resolved %s check without claiming OpenAI transport', (adapterId) => {
  showResult({
    ...baseResult, provider: 'codex',
    adapterRoute: { adapterId, endpoint: 'native SDK', reason: 'Resolved by engine' },
    sdk: { ok: false, durationMs: 10, error: { message: 'Missing prerequisite' } },
    axios: { ok: false, skipped: true, durationMs: 0, content: 'Independent HTTP cross-check is not applicable.' },
    adapter: { ok: false, durationMs: 10, error: { message: 'Adapter prerequisite missing' } },
  });
  expect(screen.getByText(`Connection check via ${adapterId} (used by flows)`)).toBeInTheDocument();
  expect(screen.queryByText('OpenAI SDK (used by flows)')).not.toBeInTheDocument();
  expect(screen.queryByText('Codex SDK (used by flows)')).not.toBeInTheDocument();
  expect(screen.getByText('Missing prerequisite')).toBeInTheDocument();
  expect(screen.getByText('Independent HTTP cross-check is not applicable.')).toBeInTheDocument();
  expect(screen.getByText('Adapter prerequisite missing')).toBeInTheDocument();
});

it.each(['openai', 'openai-responses'])('keeps the verified %s SDK label despite a different provider name', (adapterId) => {
  showResult({ ...baseResult, provider: 'claude', adapterRoute: { adapterId, endpoint: '/responses', reason: 'Explicit override' } });
  expect(screen.getByText('OpenAI SDK (used by flows)')).toBeInTheDocument();
});

it('labels a resolved Codex route independently of the provider name', () => {
  showResult({ ...baseResult, provider: 'custom', adapterRoute: { adapterId: 'codex-cli', endpoint: 'local CLI', reason: 'Explicit override' } });
  expect(screen.getByText('Codex SDK (used by flows)')).toBeInTheDocument();
});

it('does not infer a transport when older results have no resolved route', () => {
  showResult({ ...baseResult, provider: 'codex', adapterRoute: undefined });
  expect(screen.getByText('Connection check')).toBeInTheDocument();
  expect(screen.queryByText('Codex SDK (used by flows)')).not.toBeInTheDocument();
});
