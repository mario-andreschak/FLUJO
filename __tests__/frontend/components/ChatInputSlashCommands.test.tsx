import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { SlashCommandHost, SlashCommandId } from '@/frontend/components/Chat/slashCommands';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

// Slate cannot be typed into under jsdom. The stand-in forwards the same
// value, key and accessibility props, which is the contract ChatInput uses.
jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ReactModule.forwardRef(function MockEditor(
      { value, onChange, ariaLabel, ariaControls, ariaActiveDescendant, onKeyDown }: {
        value: string;
        onChange: (value: string) => void;
        ariaLabel: string;
        ariaControls?: string;
        ariaActiveDescendant?: string;
        onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
      },
      ref: React.Ref<{ insertText: (text: string) => void; focus: () => void }>,
    ) {
      const inner = ReactModule.useRef<HTMLTextAreaElement>(null);
      ReactModule.useImperativeHandle(ref, () => ({
        insertText: () => undefined,
        focus: () => inner.current?.focus(),
      }));
      return (
        <textarea
          ref={inner}
          aria-label={ariaLabel}
          aria-controls={ariaControls}
          aria-activedescendant={ariaActiveDescendant}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown as unknown as React.KeyboardEventHandler<HTMLTextAreaElement>}
        />
      );
    }),
  };
});

import ChatInput from '@/frontend/components/Chat/ChatInput';

function host(unavailable: SlashCommandId[] = []): jest.Mocked<SlashCommandHost> {
  return {
    availability: jest.fn((id: SlashCommandId) => unavailable.includes(id)
      ? { available: false as const, reason: `No ${id} here.` }
      : { available: true as const }),
    run: jest.fn(async (id: SlashCommandId, args: string) => ({
      tone: 'success' as const, title: `Ran ${id}`, lines: [args ? `with ${args}` : 'no text'],
    })),
  };
}

const type = (value: string) => fireEvent.change(screen.getByLabelText('Message'), { target: { value } });
const press = (key: string, options: Partial<KeyboardEvent> = {}) =>
  fireEvent.keyDown(screen.getByLabelText('Message'), { key, ...options });
const flush = () => act(async () => { await Promise.resolve(); });

describe('ChatInput slash commands (#1225)', () => {
  it('opens a filterable command list on "/" and runs the highlighted command with Enter', async () => {
    const commands = host(['goal']);
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} slashCommands={commands} />);

    type('/');
    const list = screen.getByRole('listbox', { name: 'Commands' });
    const names = within(list).getAllByRole('option').map(option => option.textContent);
    expect(names.some(name => name?.startsWith('/compact'))).toBe(true);
    // A command that makes no sense here is hidden from the list.
    expect(names.some(name => name?.startsWith('/goal'))).toBe(false);

    type('/co');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map(option => option.id.replace('chat-slash-command-menu-', ''))).toEqual(['compact', 'context']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-activedescendant', options[0].id);

    press('ArrowDown');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    press('Enter');
    await flush();

    expect(commands.run).toHaveBeenCalledWith('context', '');
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Ran context');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('fills in a command that takes text with Tab and runs it with that text', async () => {
    const commands = host();
    render(<ChatInput onSendMessage={jest.fn()} slashCommands={commands} />);
    type('/go');
    press('Tab');
    expect(screen.getByLabelText('Message')).toHaveValue('/goal ');
    type('/goal Ship the release');
    press('Enter');
    await flush();
    expect(commands.run).toHaveBeenCalledWith('goal', 'Ship the release');
  });

  it('closes the list with Escape and keeps the typed text', () => {
    render(<ChatInput onSendMessage={jest.fn()} slashCommands={host()} />);
    type('/he');
    press('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByLabelText('Message')).toHaveValue('/he');
  });

  it('sends unknown commands and doubled slashes as ordinary messages', () => {
    const commands = host();
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} slashCommands={commands} />);

    type('/deploy now');
    press('Enter');
    expect(onSendMessage).toHaveBeenLastCalledWith('/deploy now', []);

    type('//goal is a word');
    press('Enter');
    expect(onSendMessage).toHaveBeenLastCalledWith('/goal is a word', []);
    expect(commands.run).not.toHaveBeenCalled();
  });

  it('explains a command that does not fit this chat and keeps the text', async () => {
    const commands = host(['compact']);
    render(<ChatInput onSendMessage={jest.fn()} slashCommands={commands} />);
    type('/compact');
    press('Enter');
    await flush();
    expect(screen.getByTestId('chat-slash-menu')).toHaveTextContent('No compact here.');
    expect(commands.run).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('No compact here.');
    expect(screen.getByLabelText('Message')).toHaveValue('/compact');
  });

  it('gives the text back when a command fails, and the answer can be closed', async () => {
    const commands = host();
    commands.run.mockResolvedValueOnce({ tone: 'error', title: '/goal', lines: ['It did not work: offline'] });
    render(<ChatInput onSendMessage={jest.fn()} slashCommands={commands} />);
    type('/goal Ship it');
    press('Enter');
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByLabelText('Message')).toHaveValue('/goal Ship it');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs commands while sending is paused, for example during a tool approval', async () => {
    const commands = host();
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} slashCommands={commands} disabled />);
    type('/status');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await flush();
    expect(commands.run).toHaveBeenCalledWith('status', '');
    type('plain text');
    press('Enter');
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('shows an answer only in the chat it belongs to', async () => {
    const commands = host();
    commands.run.mockResolvedValueOnce({ tone: 'success', title: 'Copied', conversationId: 'copy-1' });
    const { rerender } = render(<ChatInput onSendMessage={jest.fn()} slashCommands={commands} slashNoticeKey="conv-1" />);
    type('/fork');
    press('Enter');
    await flush();
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<ChatInput onSendMessage={jest.fn()} slashCommands={commands} slashNoticeKey="copy-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('treats "/" as plain text when the page offers no commands', () => {
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);
    type('/compact');
    expect(screen.queryByRole('listbox')).toBeNull();
    press('Enter');
    expect(onSendMessage).toHaveBeenCalledWith('/compact', []);
  });
});
