import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextDecoder as NodeTextDecoder } from 'util';
import type OpenAI from 'openai';
import { ToolCallTimeline } from '@/frontend/components/Chat/ChatMessages';
import type { ToolCallPair } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: () => <div data-testid="mcp-app-frame" />,
}));

const RESULT_PAGE_BYTES = 64 * 1024;
const originalFetch = global.fetch;
const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const originalTextDecoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder');

function resultPair(content: string): ToolCallPair<FlujoChatMessage> {
  const toolCall: OpenAI.ChatCompletionMessageFunctionToolCall = {
    id: 'call-large-result',
    type: 'function',
    function: { name: 'large_result', arguments: '{}' },
  };
  return {
    toolCall,
    result: {
      id: 'result-large',
      timestamp: Date.now(),
      role: 'tool',
      tool_call_id: toolCall.id,
      content,
    },
  };
}

function expandResult() {
  fireEvent.click(screen.getByRole('button', { name: 'Show call and result' }));
}

afterEach(() => {
  global.fetch = originalFetch;
  if (originalWorkerDescriptor) {
    Object.defineProperty(globalThis, 'Worker', originalWorkerDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'Worker');
  }
  if (originalTextDecoderDescriptor) {
    Object.defineProperty(globalThis, 'TextDecoder', originalTextDecoderDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'TextDecoder');
  }
  jest.restoreAllMocks();
});

describe('large tool-result paging', () => {
  it('uses byte ranges and renders only the selected remote payload page', async () => {
    Object.defineProperty(globalThis, 'TextDecoder', {
      configurable: true,
      writable: true,
      value: NodeTextDecoder,
    });
    const firstPage = `FIRST-PAGE${'A'.repeat(RESULT_PAGE_BYTES - 'FIRST-PAGE'.length)}`;
    const payloadText = `${firstPage}SECOND-PAGE${'B'.repeat(512)}`;
    const encoded = Uint8Array.from(payloadText, (character) => character.charCodeAt(0));
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const range = headers?.Range ?? headers?.range;
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (!match) throw new Error('Expected a byte-range request');
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), encoded.length - 1);
      const body = encoded.slice(start, end + 1);
      return {
        ok: true,
        status: 206,
        headers: new Headers({
          'Content-Range': `bytes ${start}-${end}/${encoded.length}`,
        }),
        arrayBuffer: async () => body.buffer,
      } as Response;
    });
    global.fetch = fetchMock;

    const pair = resultPair('inline preview');
    pair.resultPayload = {
      uri: 'flujo://run/run-1/result-1',
      href: '/v1/chat/conversations/chat-1/resources/result-1/content',
      size: encoded.length,
      mimeType: 'application/json',
    };
    render(<ToolCallTimeline pairs={[pair]} messageId="assistant-large-remote" />);
    expandResult();

    await screen.findByText((text) => text.startsWith('FIRST-PAGE'));
    expect(screen.getByText('Page 1 / 2')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      pair.resultPayload.href,
      expect.objectContaining({
        headers: { Range: `bytes=0-${RESULT_PAGE_BYTES + 2}` },
        signal: expect.any(AbortSignal),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText((text) => text.startsWith('SECOND-PAGE'));
    expect(screen.getByText('Page 2 / 2')).toBeInTheDocument();
    expect(screen.queryByText((text) => text.startsWith('FIRST-PAGE'))).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      pair.resultPayload.href,
      expect.objectContaining({
        headers: { Range: `bytes=${RESULT_PAGE_BYTES - 3}-${encoded.length - 1}` },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('keeps large structured results in the worker and mounts one item page at a time', async () => {
    class WorkerMock {
      static instances: WorkerMock[] = [];
      readonly documents = new Map<string, unknown[]>();
      readonly terminate = jest.fn();
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor() {
        WorkerMock.instances.push(this);
      }

      postMessage(message: {
        type: 'open' | 'page' | 'close';
        requestId: string;
        content?: string;
        offset?: number;
        limit?: number;
      }) {
        if (message.type === 'open') {
          const value = JSON.parse(message.content ?? '[]') as unknown[];
          this.documents.set(message.requestId, value);
          queueMicrotask(() => this.onmessage?.({
            data: {
              type: 'opened',
              requestId: message.requestId,
              meta: { kind: 'array', length: value.length },
            },
          } as MessageEvent));
        } else if (message.type === 'page') {
          const value = this.documents.get(message.requestId) ?? [];
          const offset = message.offset ?? 0;
          const limit = message.limit ?? 1;
          queueMicrotask(() => this.onmessage?.({
            data: {
              type: 'page',
              requestId: message.requestId,
              items: value.slice(offset, offset + limit).map((item) => JSON.stringify(item, null, 2)),
            },
          } as MessageEvent));
        } else {
          this.documents.delete(message.requestId);
        }
      }
    }
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: WorkerMock,
    });

    const values = Array.from({ length: 70 }, (_, index) => ({
      marker: `entry-${index}`,
      body: 'x'.repeat(1_000),
    }));
    render(
      <ToolCallTimeline
        pairs={[resultPair(JSON.stringify(values))]}
        messageId="assistant-large-structured"
      />,
    );
    expandResult();

    await screen.findByText(/entry-0/);
    expect(screen.getByText('Page 1 / 2')).toBeInTheDocument();
    expect(screen.getByText(/entry-49/)).toBeInTheDocument();
    expect(screen.queryByText(/entry-50/)).not.toBeInTheDocument();
    expect(WorkerMock.instances).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/entry-50/);
    expect(screen.getByText(/entry-69/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/entry-0/)).not.toBeInTheDocument());
  });
});
