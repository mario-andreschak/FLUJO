import { chatService } from '@/frontend/services/chat';
import { magicLinkUrl } from '@/frontend/utils/magicLink';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_STORAGE_KEY,
  __resetWorkspaceSelectionForTests,
  initializeWorkspaceSelection,
  isValidWorkspaceName,
  readWorkspacePageRequest,
  withWorkspaceUrl,
  workspacePageUrl,
  workspaceStorageNavigationUrl,
} from '@/frontend/utils/workspaceSelection';
import {
  workspaceAwareEndpointPath,
  workspaceHeaderForReference,
} from '@/frontend/components/Docs/apiReference';
import {
  FLOW_CLIPBOARD_STORAGE_KEY,
  flowClipboardStorageKey,
  migrateLegacyBrowserWorkspaceContent,
  ticketDraftStorageKey,
} from '@/frontend/utils/workspaceContentKeys';
import { TICKET_DRAFT_STORAGE_KEY } from '@/shared/types/ticket';

class FakeEventSource {
  static urls: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    FakeEventSource.urls.push(String(url));
  }

  close() {}
}

describe('browser workspace propagation', () => {
  beforeEach(() => {
    __resetWorkspaceSelectionForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    FakeEventSource.urls = [];
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
  });

  it('adds the selected workspace to copied URLs and both SSE streams', () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'team-a');

    expect(withWorkspaceUrl('/api/model?x=1')).toBe('/api/model?x=1&workspace=team-a');
    expect(magicLinkUrl({ kind: 'flow', id: 'flow-1' }))
      .toBe('http://localhost/flows?flow=flow-1&workspace=team-a');

    chatService.subscribeToEvents('conversation-1', { onEvent: () => undefined }, 7);
    chatService.subscribeToSidebarEvents({ onEvent: () => undefined });
    expect(FakeEventSource.urls).toEqual([
      '/v1/chat/conversations/conversation-1/events?fromSeq=7&workspace=team-a',
      '/v1/chat/events?scope=sidebar&workspace=team-a',
    ]);
  });

  it('treats only a top-level deep-link workspace as authoritative and rewrites it on switch', () => {
    expect(readWorkspacePageRequest('http://localhost/chat?conversation=c1&workspace=team-b'))
      .toEqual({ kind: 'valid', workspace: 'team-b' });
    expect(readWorkspacePageRequest('http://localhost/chat?workspace=team-a&workspace=team-b'))
      .toEqual({ kind: 'invalid', raw: 'team-a,team-b' });

    const switched = workspacePageUrl(
      'team-b',
      'http://localhost/chat?conversation=c1&workspace=team-a#message-4',
    );
    expect(switched).toBe(
      'http://localhost/chat?conversation=c1&workspace=team-b#message-4',
    );
  });

  it('navigates cross-tab changes to an agreeing URL instead of reloading a stale explicit URL', () => {
    expect(workspaceStorageNavigationUrl(
      'team-b',
      'team-a',
      'http://localhost/chat?conversation=c1&workspace=team-a',
    )).toBe('http://localhost/chat?conversation=c1&workspace=team-b');
    expect(workspaceStorageNavigationUrl(
      'team-a',
      'team-a',
      'http://localhost/chat?workspace=team-a',
    )).toBeNull();
  });

  it('freezes this tab request routing when another tab changes localStorage', async () => {
    window.history.replaceState({}, '', '/chat?workspace=team-a');
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'team-a');
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    initializeWorkspaceSelection();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'team-b');
    await window.fetch('/api/model');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/model?workspace=team-a',
      undefined,
    );
  });

  it('makes non-default API reference paths explicit without encoding placeholders', () => {
    expect(workspaceAwareEndpointPath('/v1/chat/conversations/{conversationId}', 'team-b'))
      .toBe('/v1/chat/conversations/{conversationId}?workspace=team-b');
    expect(workspaceHeaderForReference('team-b')).toBe('x-flujo-workspace: team-b');
    expect(workspaceAwareEndpointPath('/mcp-flows', DEFAULT_WORKSPACE)).toBe('/mcp-flows');
    expect(workspaceHeaderForReference(DEFAULT_WORKSPACE)).toBeNull();
  });

  it('rejects platform-reserved workspace names before they reach an API', () => {
    expect(isValidWorkspaceName('CON')).toBe(false);
    expect(isValidWorkspaceName('lpt9')).toBe(false);
    expect(isValidWorkspaceName('console')).toBe(true);
  });

  it('moves legacy flow clipboard and ticket draft into default-workspace exactly once', () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE);
    window.localStorage.setItem(FLOW_CLIPBOARD_STORAGE_KEY, '{"nodes":[],"edges":[]}');
    window.sessionStorage.setItem(TICKET_DRAFT_STORAGE_KEY, 'ticket text');

    expect(migrateLegacyBrowserWorkspaceContent()).toMatchObject({ copied: 2, conflicts: 0 });
    expect(window.localStorage.getItem(flowClipboardStorageKey()))
      .toBe('{"nodes":[],"edges":[]}');
    expect(window.sessionStorage.getItem(ticketDraftStorageKey())).toBe('ticket text');
    expect(window.localStorage.getItem(FLOW_CLIPBOARD_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(TICKET_DRAFT_STORAGE_KEY)).toBeNull();
    expect(migrateLegacyBrowserWorkspaceContent()).toEqual({ copied: 0, conflicts: 0 });
  });

  it('preserves both values on migration conflict and never imports legacy content to a sibling', () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE);
    window.localStorage.setItem(FLOW_CLIPBOARD_STORAGE_KEY, 'legacy');
    window.localStorage.setItem(flowClipboardStorageKey(), 'scoped');
    expect(migrateLegacyBrowserWorkspaceContent()).toMatchObject({ conflicts: 1 });
    expect(window.localStorage.getItem(FLOW_CLIPBOARD_STORAGE_KEY)).toBe('legacy');
    expect(window.localStorage.getItem(flowClipboardStorageKey())).toBe('scoped');

    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'team-b');
    expect(migrateLegacyBrowserWorkspaceContent()).toEqual({ copied: 0, conflicts: 0 });
    expect(window.localStorage.getItem(flowClipboardStorageKey())).toBeNull();
    expect(window.localStorage.getItem(FLOW_CLIPBOARD_STORAGE_KEY)).toBe('legacy');
  });
});
