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
} from '@/frontend/components/shared/GlobalReferenceEditor';
import { createPromptReferenceSuggestion } from '@/utils/shared/promptRefs';

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
