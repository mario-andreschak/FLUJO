/**
 * "How events arrive" in the event trigger editor (#1401, #1448): only the modes
 * the chosen event offers, push preferred, then poll, then webhook.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import McpEventPanel from '@/frontend/components/PlannedExecutions/McpEventPanel';
import type { McpEventTriggerConfig } from '@/shared/types/plannedExecution';

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: jest.fn(async () => [{ name: 'chat' }]),
    listServerEvents: jest.fn(async () => ({
      supported: true,
      channel: false,
      events: [
        { name: 'message.received', delivery: ['webhook', 'poll'] },
        { name: 'incident.created', delivery: ['webhook', 'push', 'poll'] },
        { name: 'legacy.event' },
      ],
    })),
  },
}));

function Harness({ onChange }: { onChange: (config: McpEventTriggerConfig) => void }) {
  const [config, setConfig] = useState<McpEventTriggerConfig>({ type: 'mcp-event', serverName: 'chat', eventName: '', secret: '' });
  return <McpEventPanel config={config} onChange={(next) => { setConfig(next); onChange(next); }} />;
}

async function pick(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: option }));
}

async function options(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  const names = within(listbox).getAllByRole('option').map(element => element.textContent);
  fireEvent.keyDown(listbox, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  return names;
}

describe('McpEventPanel delivery mode', () => {
  it('preselects push when the event offers it and lists only offered modes', async () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await screen.findByRole('combobox', { name: 'Event' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Event' })).not.toHaveAttribute('aria-disabled', 'true'));
    await pick('Event', 'incident.created');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: 'incident.created', delivery: 'push' }));
    expect(await options('How events arrive')).toEqual([
      'Push: right away, over the open connection',
      'Poll: FLUJO asks the server regularly',
      'Webhook: the server calls FLUJO',
    ]);
  });

  it('falls back to poll, and to webhook for an event from an earlier draft', async () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Event' })).not.toHaveAttribute('aria-disabled', 'true'));
    await pick('Event', 'message.received');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'poll' }));
    expect(await options('How events arrive')).toEqual(['Poll: FLUJO asks the server regularly', 'Webhook: the server calls FLUJO']);

    await pick('How events arrive', 'Webhook: the server calls FLUJO');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'webhook' }));

    await pick('Event', 'legacy.event');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eventName: 'legacy.event', delivery: 'webhook' }));
    expect(await options('How events arrive')).toEqual(['Webhook: the server calls FLUJO']);
  });
});
