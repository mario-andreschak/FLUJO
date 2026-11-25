import { fireEvent, render, screen, within } from '@testing-library/react';
import ConversationStats, { formatTokens } from '@/frontend/components/Chat/ConversationStats';

const usage = { promptTokens: 6468947, completionTokens: 39596, totalTokens: 6508543, cacheReadTokens: 5781984 };

it('labels full input and output separately and uses the actual context snapshot', () => {
  render(<ConversationStats usage={usage} availableNodes={[]} contextInfo={{
    promptTokens: 165897, completionTokens: 390, totalTokens: 166287, contextWindow: 258400,
  }} />);
  expect(screen.getByText('6.47M in · 39.6k out')).toBeInTheDocument();
  expect(screen.getByText('Context 166k/258k (64%)')).toBeInTheDocument();
  expect(screen.queryByText(/fresh tokens/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('6.47M in · 39.6k out'));
  const table = screen.getByRole('table');
  expect(within(table).getByRole('columnheader', { name: 'Total processed' })).toBeInTheDocument();
  expect(within(table).getByText('6,508,543')).toBeInTheDocument();
  expect(within(table).getByText('6,468,947')).toBeInTheDocument();
  expect(within(table).getByText('39,596')).toBeInTheDocument();
  expect(within(table).getByText('5,781,984')).toBeInTheDocument();
});

it('shows unknown context without inventing 0% or displaying accumulated usage as context', () => {
  render(<ConversationStats usage={usage} contextInfo={{ modelDisplayName: 'Codex' }} availableNodes={[]} />);
  expect(screen.getByText('Context unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it('shows a known context size without inventing a denominator', () => {
  render(<ConversationStats usage={undefined} contextInfo={{ promptTokens: 12345 }} availableNodes={[]} />);
  expect(screen.getByText('Context 12.3k')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it('preserves an over-limit reading in text while bounding only the visual bar', () => {
  render(<ConversationStats usage={undefined} contextInfo={{ promptTokens: 120000, contextWindow: 100000 }} availableNodes={[]} />);
  expect(screen.getByText('Context 120k/100k (120%)')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
});

it('formats large accumulated totals in millions', () => {
  expect(formatTokens(5606187)).toBe('5.61M');
  expect(formatTokens(1000000)).toBe('1M');
});

it('labels a configured limit and distinguishes unreported cache counts from zero', async () => {
  render(<ConversationStats usage={{ promptTokens: 1000, completionTokens: 50, totalTokens: 1050 }}
    availableNodes={[]} contextInfo={{ promptTokens: 1000, contextWindow: 200000, contextWindowSource: 'configured' }} />);
  fireEvent.mouseOver(screen.getByText('Context 1.0k/200k (1%)'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Limit from model settings.');
  fireEvent.click(screen.getByText('1.0k in · 50 out'));
  expect(within(screen.getByRole('table')).getAllByText('—')).toHaveLength(2);
});

describe('a server that sends no token counts (issue #1367)', () => {
  it('says "not reported" instead of showing 0', () => {
    render(<ConversationStats usage={{ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, byNode: {}, unreportedCalls: 2 }}
      availableNodes={[]} contextInfo={undefined} />);
    expect(screen.getByTestId('tokens-not-reported')).toHaveTextContent('Tokens not reported');
    expect(screen.queryByText(/0 in · 0 out/)).not.toBeInTheDocument();
  });

  it('notes the calls it could not count when other calls were counted', () => {
    render(<ConversationStats usage={{ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, costUsd: 0, byNode: {}, unreportedCalls: 1 }}
      availableNodes={[]} contextInfo={undefined} />);
    expect(screen.queryByTestId('tokens-not-reported')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('1.0k in · 50 out'));
    expect(screen.getByText('Model calls without token counts from the AI server: 1. The totals leave them out.')).toBeInTheDocument();
  });
});
