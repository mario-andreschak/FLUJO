import React from 'react';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mirrors the next/navigation mock used by FlowEasyCreateRoute.test.tsx:
// push/replace actually move `window.location` (via pushState/replaceState)
// so the hook's own `window.location.search` read observes the change.
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (url: string) => {
      window.history.pushState({}, '', url);
      mockPush(url);
    },
    replace: (url: string) => {
      window.history.replaceState({}, '', url);
      mockReplace(url);
    },
    back: jest.fn(() => window.history.back()),
  }),
}));

import { useEntityDeepLink, UseEntityDeepLinkOptions } from '@/frontend/hooks/useEntityDeepLink';

function TestComponent(props: UseEntityDeepLinkOptions) {
  useEntityDeepLink(props);
  return null;
}

function setUrl(path: string) {
  window.history.pushState({}, '', path);
}

describe('useEntityDeepLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUrl('/');
  });

  it('does nothing when the param is absent from the URL', async () => {
    setUrl('/chat');
    const onResolve = jest.fn();
    render(<TestComponent param="conversation" ready exists={() => true} onResolve={onResolve} />);
    await waitFor(() => expect(onResolve).not.toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('resolves once the id is present and ready, without touching the URL by default (durable)', async () => {
    setUrl('/chat?conversation=conv-1');
    const onResolve = jest.fn();
    render(
      <TestComponent
        param="conversation"
        ready
        exists={(id) => id === 'conv-1'}
        onResolve={onResolve}
      />
    );
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('conv-1'));
    // Durable (consume defaults to false): the param stays in the URL.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(window.location.search).toContain('conversation=conv-1');
  });

  it('waits for `ready` before resolving, then resolves on the next render', async () => {
    setUrl('/chat?conversation=conv-1');
    const onResolve = jest.fn();
    const { rerender } = render(
      <TestComponent param="conversation" ready={false} exists={() => true} onResolve={onResolve} />
    );
    expect(onResolve).not.toHaveBeenCalled();
    rerender(<TestComponent param="conversation" ready exists={() => true} onResolve={onResolve} />);
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('conv-1'));
  });

  it('ignores an id that does not exist (fail closed) and never calls onResolve', async () => {
    setUrl('/chat?conversation=ghost');
    const onResolve = jest.fn();
    render(
      <TestComponent
        param="conversation"
        ready
        exists={(id) => id === 'conv-1'}
        onResolve={onResolve}
        consume
        replacePath="/chat"
      />
    );
    // Still strips the dead param from the URL when `consume` is set, but
    // never hands the invalid id to the caller.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/chat'));
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('consumes (clears) the param via router.replace after resolving when consume=true', async () => {
    setUrl('/chat?flow=flow-1&other=kept');
    const onResolve = jest.fn();
    render(
      <TestComponent
        param="flow"
        ready
        exists={(id) => id === 'flow-1'}
        onResolve={onResolve}
        consume
        replacePath="/chat"
      />
    );
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('flow-1'));
    expect(mockReplace).toHaveBeenCalledWith('/chat');
  });

  it('resolves at most once per mount even if `ready` flips again', async () => {
    setUrl('/chat?conversation=conv-1');
    const onResolve = jest.fn();
    const { rerender } = render(
      <TestComponent param="conversation" ready exists={() => true} onResolve={onResolve} />
    );
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    // Flip ready off then on again — the once-guard must prevent a second call.
    rerender(<TestComponent param="conversation" ready={false} exists={() => true} onResolve={onResolve} />);
    rerender(<TestComponent param="conversation" ready exists={() => true} onResolve={onResolve} />);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});
