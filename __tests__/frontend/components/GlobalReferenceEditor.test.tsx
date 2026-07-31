import { render, screen } from '@testing-library/react';
import GlobalReferenceEditor, {
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
});
