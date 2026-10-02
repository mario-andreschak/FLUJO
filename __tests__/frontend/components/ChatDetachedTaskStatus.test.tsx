import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToolCallTimeline } from '@/frontend/components/Chat/ChatMessages';
import type { ToolCallPair } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { SubflowTaskHandle } from '@/shared/types/subflowTasks';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: () => null,
}));

function taskToolPair(id: string, name: string, data?: unknown): ToolCallPair<FlujoChatMessage> {
  return {
    toolCall: {
      id, type: 'function', function: { name, arguments: JSON.stringify({ taskId: 'detached-task' }) },
    },
    ...(data === undefined ? {} : {
      result: {
        id: `result-${id}`, timestamp: 2, role: 'tool' as const,
        tool_call_id: id, content: JSON.stringify(data),
      },
    }),
  };
}

function taskToolChip(name: string): HTMLElement {
  const chip = screen.getByText(name).closest<HTMLElement>('[role="button"]');
  if (!chip) throw new Error(`Missing tool timeline chip: ${name}`);
  return chip;
}

it('keeps the latest failed getter separate from its historical working launch (#540)', async () => {
  const working: SubflowTaskHandle = {
    version: 1, taskId: 'detached-task', uri: 'flujo://task/detached-task',
    status: 'working', pollInterval: 2000, createdAt: 1, updatedAt: 1,
  };
  const association = { childConversationId: 'detached-child', parentConversationId: 'detached-parent' };
  const historicalLaunch = taskToolPair('launch-call', 'start_subflow_worker', { ...working, ...association });
  const pendingGetter = taskToolPair('get-call', 'subflow_task_get');
  const { rerender } = render(
    <ToolCallTimeline pairs={[historicalLaunch, pendingGetter]} messageId="assistant-detached" />,
  );

  fireEvent.click(taskToolChip('start_subflow_worker'));
  expect(await screen.findByText(/"status": "working"/)).toBeInTheDocument();
  expect(within(taskToolChip('subflow_task_get')).getByRole('progressbar')).toBeInTheDocument();

  // Keep the latest getter open while its result arrives; the launch is an
  // earlier tool response, rather than an independent current-task status.
  fireEvent.click(taskToolChip('subflow_task_get'));
  expect(screen.queryByText(/"status": "working"/)).not.toBeInTheDocument();
  const failedGetter = taskToolPair('get-call', 'subflow_task_get', {
    task: { ...working, status: 'failed', updatedAt: 2, completedAt: 2 },
    ...association,
    // executeTaskGet returns this error alongside the terminal task handle;
    // ModelHandler records that data as the tool message rendered by Chat.
    error: 'Detached subflow task was interrupted by a process restart. Manual recovery is required; interrupted work was not replayed.',
  });
  rerender(
    <ToolCallTimeline pairs={[historicalLaunch, failedGetter]} messageId="assistant-detached" />,
  );

  expect(taskToolChip('subflow_task_get')).toHaveClass('MuiChip-colorError');
  expect(within(taskToolChip('subflow_task_get')).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(await screen.findByText(/"status": "failed"/)).toBeInTheDocument();
  expect(screen.getByText(/Manual recovery is required; interrupted work was not replayed/)).toBeInTheDocument();
  expect(screen.queryByText(/"status": "working"/)).not.toBeInTheDocument();

  // The original launch stays auditable under its own call ID. Switching back
  // to the latest getter must restore the terminal result, without cached data
  // from the launch replacing it.
  fireEvent.click(taskToolChip('start_subflow_worker'));
  expect(await screen.findByText(/"status": "working"/)).toBeInTheDocument();
  expect(screen.queryByText(/"status": "failed"/)).not.toBeInTheDocument();
  fireEvent.click(taskToolChip('subflow_task_get'));
  expect(await screen.findByText(/"status": "failed"/)).toBeInTheDocument();
  expect(screen.queryByText(/"status": "working"/)).not.toBeInTheDocument();
});
