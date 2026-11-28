/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import ServerTools from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/ServerTools/ServerTools';

const node = { nodeId: 'mcp-1', serverName: 'files', status: 'connected', enabledTools: [] };

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

const renderTools = (handlers: {
  handleRetryServer?: (serverName: string) => Promise<boolean>;
  handleRestartServer?: (serverName: string) => Promise<boolean>;
}) => render(
  <ServerTools
    isLoadingServers={false}
    connectedMcpNodes={[node]}
    serverToolsMap={{ files: [] }}
    serverStatuses={{ files: 'connected' }}
    isLoadingTools={{}}
    handleSelectToolServer={jest.fn()}
    handleInsertToolBinding={jest.fn()}
    selectedToolServerNodeId="mcp-1"
    selectedNodeId="process-1"
    isLoadingSelectedServerTools={false}
    promptBuilderRef={{ current: null }}
    {...handlers}
  />,
);

const actionButton = (label: string) => within(screen.getByLabelText(label)).getByRole('button');

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

it('keeps the restart controls busy until shortly after the restart finishes', async () => {
  const restart = deferred();
  const handleRestartServer = jest.fn(() => restart.promise);
  renderTools({ handleRetryServer: jest.fn().mockResolvedValue(true), handleRestartServer });

  fireEvent.click(actionButton('Restart server files'));
  expect(handleRestartServer).toHaveBeenCalledWith('files');
  expect(actionButton('Restart server files')).toBeDisabled();

  await act(async () => { restart.resolve(true); });
  await act(async () => { await jest.advanceTimersByTimeAsync(499); });
  expect(actionButton('Restart server files')).toBeDisabled();

  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  expect(actionButton('Restart server files')).toBeEnabled();
});

it('shows the retry spinner until shortly after the retry finishes', async () => {
  const handleRetryServer = jest.fn().mockResolvedValue(true);
  renderTools({ handleRetryServer });

  fireEvent.click(actionButton('Retry connection to files'));
  await act(async () => { await Promise.resolve(); });
  expect(within(screen.getByLabelText('Retry connection to files')).getByRole('progressbar')).toBeInTheDocument();

  await act(async () => { await jest.advanceTimersByTimeAsync(500); });
  expect(within(screen.getByLabelText('Retry connection to files')).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(actionButton('Retry connection to files')).toBeEnabled();
});
