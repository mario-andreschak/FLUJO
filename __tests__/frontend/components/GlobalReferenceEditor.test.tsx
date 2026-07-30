import { render, screen } from '@testing-library/react';
import GlobalReferenceEditor, {
  deserializeReferenceValue,
  filterGlobalNames,
  findGlobalCompletion,
  serializeReferenceValue,
} from '@/frontend/components/shared/GlobalReferenceEditor';

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
