import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GlobalReferenceEditor, {
  GlobalReferenceEditorRef,
  deserializeReferenceValue,
  filterGlobalNames,
  filterReferenceSuggestions,
  findAtCompletion,
  findGlobalCompletion,
  serializeReferenceValue,
  parseHitlistQuery,
} from '@/frontend/components/shared/GlobalReferenceEditor';
import { createPromptReferenceSuggestion } from '@/utils/shared/promptRefs';
import { flowService } from '@/frontend/services/flow';

jest.mock('@/frontend/services/flow', () => ({ flowService: { loadFlows: jest.fn(async () => [
  { id: 'first-flow-id', name: 'Annual report' },
  { id: 'flow-real-id', name: 'Monthly report' },
]) } }));
jest.mock('@/frontend/services/model', () => ({ modelService: { loadModels: jest.fn(async () => []) } }));
jest.mock('@/frontend/services/chat', () => ({ chatService: { listConversationPage: jest.fn(async () => ({ items: [] })) } }));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: { loadServerConfigs: jest.fn(async () => []) } }));

describe('GlobalReferenceEditor (#318)', () => {
  it('round-trips mixed and adjacent references as the original plain string', () => {
    const value = 'A ${tool:files__read}${global:API_KEY}\n${res:artifact} Z';
    expect(serializeReferenceValue(deserializeReferenceValue(value))).toBe(value);
  });

  it('finds an open global expression at the caret and filters names case-insensitively', () => {
    expect(findGlobalCompletion('before ${global:ap')).toEqual({
      query: 'ap',
      start: 7,
      end: 18,
    });
    expect(filterGlobalNames(['APP_URL', 'ZED', 'api_token', 'APP_URL'], 'ap')).toEqual([
      'api_token',
      'APP_URL',
    ]);
    expect(findGlobalCompletion('${global:closed}')).toBeNull();
    expect(findGlobalCompletion('${global:nested{')).toBeNull();
  });

  it('detects ordinary-text @ queries and filters grouped reference suggestions', () => {
    expect(findAtCompletion('before @rea')).toEqual({ query: 'rea', start: 7, end: 11 });
    expect(findAtCompletion('before @@repo')).toEqual({ query: '@repo', start: 7, end: 13 });
    expect(findAtCompletion('email@example.com')).toBeNull();
    expect(findAtCompletion('${global:@name')).toBeNull();

    const tool = createPromptReferenceSuggestion(
      { kind: 'tool', server: 'files', name: 'read' },
      'Read file',
    );
    const resource = createPromptReferenceSuggestion(
      { kind: 'resource', server: 'files', name: 'file:///readme.md' },
      'README',
    );
    const global = createPromptReferenceSuggestion(
      { kind: 'global', server: '', name: 'APP_URL' },
      'APP_URL',
    );

    expect(filterReferenceSuggestions([global, resource, tool, tool], 'read')).toEqual([
      tool,
      resource,
    ]);
  });

  it('renders a global expression as an accessible pill without rendering any variable value', () => {
    render(
      <GlobalReferenceEditor
        value="Use ${global:API_KEY}"
        onChange={jest.fn()}
        globalNames={['API_KEY']}
        ariaLabel="Test editor"
      />,
    );

    expect(screen.getByText('global:API_KEY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove global:API_KEY' })).toBeInTheDocument();
    expect(screen.queryByText('super-secret-value')).not.toBeInTheDocument();
  });

  it('separates every current command from entity hitlists and preserves requested entity fields', () => {
    for (const kind of ['conversation', 'flow', 'flows', 'node', 'model', 'app', 'time', 'date', 'folder', 'file']) {
      for (const field of ['id', 'name', 'created', 'updated']) {
        expect(findAtCompletion(`Use @current.${kind}.${field}`)).toBeNull();
      }
    }
    expect(findAtCompletion('@current.')).toBeNull();
    expect(parseHitlistQuery('flow.id')).toEqual({ scope: 'flow', query: '', field: 'id' });
    expect(parseHitlistQuery('conversation.name:budget')).toEqual({ scope: 'conversation', query: 'budget', field: 'name' });
    expect(parseHitlistQuery('model.updated')).toEqual({ scope: 'model', query: '', field: 'updated' });
    expect(parseHitlistQuery('node.name')).toEqual({ scope: 'node', query: '', field: 'name' });
    expect(parseHitlistQuery('app.created')).toEqual({ scope: 'app', query: '', field: 'created' });
    expect(parseHitlistQuery('file')).toEqual({ scope: 'file', query: '' });
    expect(parseHitlistQuery('folder')).toEqual({ scope: 'folder', query: '' });
    expect(parseHitlistQuery('flo')).toEqual({ scope: 'all', query: 'flo' });
    for (const [command, scope] of [['c', 'conversation'], ['f', 'flow'], ['m', 'model'], ['a', 'app']]) {
      expect(parseHitlistQuery(command)).toEqual({ scope, query: '' });
      expect(parseHitlistQuery(`${command}:report`)).toEqual({ scope, query: 'report' });
    }
  });

  it('renders current commands as their exact command text without an invalid-reference warning', () => {
    render(<GlobalReferenceEditor value="@current.conversation.id @current.flow.name" onChange={jest.fn()}
      suggestions={[]} enhancedHitlist ariaLabel="Test editor" />);
    expect(screen.getByText('@current.conversation.id')).toBeInTheDocument();
    expect(screen.getByText('@current.flow.name')).toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not load entity hitlists while a current command is typed', async () => {
    const editorRef = createRef<GlobalReferenceEditorRef>();
    (flowService.loadFlows as jest.Mock).mockClear();
    render(<GlobalReferenceEditor ref={editorRef} value="" onChange={jest.fn()}
      enhancedHitlist ariaLabel="Test editor" />);
    fireEvent.mouseDown(document.querySelector('.global-reference-editor') as HTMLElement);
    act(() => editorRef.current?.insertText('@current.'));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('@current.'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(flowService.loadFlows).not.toHaveBeenCalled();
  });

  it('selects a named flow and retains the requested field instead of inserting the current flow', async () => {
    const editorRef = createRef<GlobalReferenceEditorRef>();
    const onChange = jest.fn();
    render(<GlobalReferenceEditor ref={editorRef} value="" onChange={onChange}
      suggestions={[]} enhancedHitlist ariaLabel="Test editor" />);
    fireEvent.mouseDown(document.querySelector('.global-reference-editor') as HTMLElement);
    act(() => { for (const character of '@flow.name') editorRef.current?.insertText(character); });
    const choice = await screen.findByText('Monthly report');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    // Accessible activation dispatches click; it need not include mousedown.
    fireEvent.click(choice);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('@flows[flow-real-id].name'));
    expect(screen.getByText('@flow[Monthly report].name')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it('inserts the second flow through keyboard navigation', async () => {
    const editorRef = createRef<GlobalReferenceEditorRef>();
    const onChange = jest.fn();
    render(<GlobalReferenceEditor ref={editorRef} value="" onChange={onChange}
      enhancedHitlist ariaLabel="Test editor" />);
    fireEvent.mouseDown(document.querySelector('.global-reference-editor') as HTMLElement);
    act(() => { for (const character of '@flow.updated') editorRef.current?.insertText(character); });
    await screen.findByText('Monthly report');
    const textbox = screen.getByRole('textbox');
    // jsdom does not implement the contentEditable property Slate checks.
    Object.defineProperty(textbox, 'isContentEditable', { value: true });
    fireEvent.keyDown(textbox, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Monthly report/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('@flows[flow-real-id].updated'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('includes MCP servers alongside UI apps in the app picker', async () => {
    const editorRef = createRef<GlobalReferenceEditorRef>();
    const onChange = jest.fn();
    render(<GlobalReferenceEditor ref={editorRef} value="" onChange={onChange}
      suggestions={[{ kind: 'mention', server: 'bank', name: 'bank', label: 'Bank tools',
        category: 'mcpserver', value: '@app[bank]' }]}
      ariaLabel="Test editor" />);
    fireEvent.mouseDown(document.querySelector('.global-reference-editor') as HTMLElement);
    act(() => { for (const character of '@app.name') editorRef.current?.insertText(character); });
    fireEvent.click(await screen.findByRole('option', { name: /Bank tools/ }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('@app[bank].name'));
  });

  it.each(['file', 'folder'])('keeps a selected remote %s readable and valid after search closes', async kind => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [
      { path: '/workspace/report', name: 'report', isDirectory: kind === 'folder' },
    ] }) })) as unknown as typeof fetch;
    try {
      const editorRef = createRef<GlobalReferenceEditorRef>();
      const onChange = jest.fn();
      render(<GlobalReferenceEditor ref={editorRef} value="" onChange={onChange}
        suggestions={[]} enhancedHitlist ariaLabel="Test editor" />);
      fireEvent.mouseDown(document.querySelector('.global-reference-editor') as HTMLElement);
      act(() => { for (const character of `@${kind}.name:report`) editorRef.current?.insertText(character); });
      fireEvent.click(await screen.findByRole('option', { name: 'report /workspace/report' }));
      await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(`@${kind}[%2Fworkspace%2Freport].name`));
      expect(screen.getByText(`@${kind}[report].name`)).toBeInTheDocument();
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('can open the completion hitlist above the editor', async () => {
    const editorRef = createRef<GlobalReferenceEditorRef>();
    render(
      <GlobalReferenceEditor
        ref={editorRef}
        value=""
        onChange={jest.fn()}
        globalNames={['API_KEY']}
        ariaLabel="Test editor"
        hitlistPlacement="top"
      />,
    );

    fireEvent.mouseDown(document.querySelector('.global-reference-editor') as HTMLElement);
    act(() => editorRef.current?.insertText('@'));

    const hitlist = await waitFor(() => screen.getByRole('listbox'));
    expect(hitlist).toHaveStyle({ bottom: '100%' });
    expect(hitlist).not.toHaveStyle({ top: '100%' });
  });
});
