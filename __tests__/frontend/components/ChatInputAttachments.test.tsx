import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('@mui/material', () => {
  const actual = jest.requireActual('@mui/material');
  return { ...actual, useMediaQuery: () => false };
});

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => ({
  __esModule: true,
  default: ({ value, onChange, ariaLabel, onPaste }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    onPaste?: (event: React.ClipboardEvent) => void;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onPaste={onPaste} onChange={(event) => onChange(event.target.value)} />
  ),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

import ChatInput from '@/frontend/components/Chat/ChatInput';

const MiB = 1024 * 1024;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

interface PrepareCall { name: string | null; release: () => void }

function installServer(): PrepareCall[] {
  const calls: PrepareCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (!init?.method || init.method === 'GET') {
      return jsonResponse({ defaults: { defaultMaxFileBytes: 16 * MiB, maxInlineBytes: 8 * MiB } });
    }
    const name = url.searchParams.get('name');
    let release = () => undefined as void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    calls.push({ name, release });
    if (name === 'slow.docx') await gate;
    const body = name?.endsWith('.docx') || name?.endsWith('.zip')
      ? { kind: 'text', text: '# Garden plan', note: { code: 'text-extracted', values: { format: 'Word document' } } }
      : name?.endsWith('.xls')
        ? { kind: 'text', text: '## Sheet: Harvest\nCrop,Kilos', note: { code: 'text-extracted', values: { format: 'Excel 97-2003 workbook' } } }
        : { kind: 'note', note: { code: 'name-only' } };
    return jsonResponse(body);
  }) as typeof fetch;
  return calls;
}

const fileTransfer = (files: File[]) => ({ files, types: ['Files'], dropEffect: 'none' });

function sized(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('ChatInput attachments of every kind (#1224)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('shows a chip per dropped file with what will be sent, and never drops a file', async () => {
    installServer();
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);

    fireEvent.drop(screen.getByTestId('chat-input-dropzone'), { dataTransfer: fileTransfer([
      new File(['PK fake'], 'plan.docx'),
      new File([new Uint8Array([0, 1, 2, 3])], 'tool.bin'),
      sized(new File(['x'], 'movie.mov', { type: 'video/quicktime' }), 40 * MiB),
      new File(['old'], 'budget.xls'),
      new File(['a,b\n1,2\n'], 'numbers.csv'),
      new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], 'memo.mp3', { type: 'audio/mpeg' }),
    ]) });

    await waitFor(() => expect(screen.queryByText('Reading…')).not.toBeInTheDocument());
    const statuses = screen.getAllByTestId('chat-attachment-status').map(element => element.textContent);
    expect(statuses).toEqual([
      'Text extracted',
      'Can’t be read: only the name is sent',
      'Too large (limit 16 MB): not sent',
      'Text extracted',
      'Sent as text',
      'Sent as audio; models that can’t listen get a transcript',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(1));
    const [, attachments] = onSendMessage.mock.calls[0];
    expect(attachments).toHaveLength(6);
    expect(attachments[0]).toMatchObject({ type: 'document', content: '# Garden plan', originalName: 'plan.docx' });
    expect(attachments[1]).toMatchObject({ originalName: 'tool.bin', content: '', note: { code: 'name-only' } });
    expect(attachments[2]).toMatchObject({ originalName: 'movie.mov', note: { code: 'too-large', values: { limit: 16 * MiB } } });
    expect(attachments[3]).toMatchObject({ originalName: 'budget.xls', content: '## Sheet: Harvest\nCrop,Kilos', note: { code: 'text-extracted' } });
    expect(attachments[4]).toMatchObject({ content: 'a,b\n1,2\n', language: 'csv', note: { code: 'text' } });
    expect(attachments[5]).toMatchObject({ type: 'audio', originalName: 'memo.mp3', mimeType: 'audio/mpeg', note: { code: 'audio' } });
    expect(attachments[5].content).toMatch(/^data:audio\/mpeg;base64,/);
  });

  it('waits for files that are still being read before sending', async () => {
    const calls = installServer();
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);
    fireEvent.drop(screen.getByTestId('chat-input-dropzone'), { dataTransfer: fileTransfer([new File(['PK'], 'slow.docx')]) });

    expect(await screen.findByText('Reading…')).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

    await act(async () => { calls[0].release(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    expect(within(screen.getByTestId('chat-attachment-chip')).getByText('Text extracted')).toBeInTheDocument();
  });

  it('accepts several files of any type from the attach button', async () => {
    installServer();
    render(<ChatInput onSendMessage={() => undefined} />);
    const input = screen.getByTestId('chat-attach-input') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('');

    fireEvent.change(input, { target: { files: [new File(['notes'], 'readme'), new File(['PK'], 'bundle.zip')] } });
    expect(await screen.findByText('readme')).toBeInTheDocument();
    expect(await screen.findByText('bundle.zip')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('chat-attachment-status').map(element => element.textContent))
      .toEqual(['Sent as text', 'Text extracted']));
  });

  it('attaches pasted files of any type, not only images', async () => {
    installServer();
    render(<ChatInput onSendMessage={() => undefined} />);
    const file = new File(['# Title'], 'notes.md');
    fireEvent.paste(screen.getByLabelText('Message'), {
      clipboardData: { items: [{ kind: 'file', type: '', getAsFile: () => file }] },
    });
    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('chat-attachment-status')).toHaveTextContent('Sent as text'));
  });

  it('still attaches a file when the server cannot be reached', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    const onSendMessage = jest.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);
    fireEvent.drop(screen.getByTestId('chat-input-dropzone'), { dataTransfer: fileTransfer([new File(['PK'], 'plan.docx')]) });
    await waitFor(() => expect(screen.getByTestId('chat-attachment-status')).toHaveTextContent('Could not be read: only the name is sent'));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('', [expect.objectContaining({ originalName: 'plan.docx', note: { code: 'failed' } })]));
  });
});
