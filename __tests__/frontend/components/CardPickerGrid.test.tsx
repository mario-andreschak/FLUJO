import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import CardPickerGrid, { CardPickerItem } from '@/frontend/components/shared/CardPickerGrid';

const items: CardPickerItem[] = [
  { key: '1', content: <div>Card One</div>, searchText: 'One' },
  { key: '2', content: <div>Card Two</div>, searchText: 'Two' },
];

describe('CardPickerGrid', () => {
  it('does not render a search field when searchable is false', () => {
    render(<CardPickerGrid items={items} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('auto-focuses the search field on mount when searchable (default on)', async () => {
    render(<CardPickerGrid items={items} searchable onSearchChange={jest.fn()} searchTerm="" />);
    const input = screen.getByRole('textbox', { name: 'common.search' });
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('does not auto-focus when autoFocusSearch is explicitly false', async () => {
    render(
      <CardPickerGrid
        items={items}
        searchable
        autoFocusSearch={false}
        onSearchChange={jest.fn()}
        searchTerm=""
      />,
    );
    const input = screen.getByRole('textbox', { name: 'common.search' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(input).not.toHaveFocus();
  });

  it('re-focuses when autoFocusSearch flips false -> true (dialog re-open)', async () => {
    const { rerender } = render(
      <CardPickerGrid
        items={items}
        searchable
        autoFocusSearch={false}
        onSearchChange={jest.fn()}
        searchTerm=""
      />,
    );
    let input = screen.getByRole('textbox', { name: 'common.search' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(input).not.toHaveFocus();

    rerender(
      <CardPickerGrid
        items={items}
        searchable
        autoFocusSearch
        onSearchChange={jest.fn()}
        searchTerm=""
      />,
    );
    input = screen.getByRole('textbox', { name: 'common.search' });
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('drives onSearchChange as the user types (controlled)', async () => {
    const onSearchChange = jest.fn();
    render(<CardPickerGrid items={items} searchable onSearchChange={onSearchChange} searchTerm="" />);
    const input = screen.getByRole('textbox', { name: 'common.search' });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: 'One' } });
    expect(onSearchChange).toHaveBeenCalledWith('One');
  });

  it('filters uncontrolled items by searchText when no onSearchChange is supplied', async () => {
    render(<CardPickerGrid items={items} searchable />);
    const input = screen.getByRole('textbox', { name: 'common.search' });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: 'Two' } });
    expect(screen.queryByText('Card One')).not.toBeInTheDocument();
    expect(screen.getByText('Card Two')).toBeInTheDocument();
  });

  it('wraps the search field in a sticky wrapper pinned to the top of its container by default', async () => {
    render(<CardPickerGrid items={items} searchable onSearchChange={jest.fn()} searchTerm="" />);
    const input = screen.getByRole('textbox', { name: 'common.search' });
    // StickySearchBar renders an ancestor Box around the field's containing div.
    const stickyWrapper = input.closest('.MuiBox-root') as HTMLElement;
    expect(stickyWrapper).toHaveStyle({ position: 'sticky', top: '0px' });
  });

  it('disables the sticky wrapper when stickySearch is false', () => {
    render(
      <CardPickerGrid
        items={items}
        searchable
        stickySearch={false}
        onSearchChange={jest.fn()}
        searchTerm=""
      />,
    );
    const input = screen.getByRole('textbox', { name: 'common.search' });
    const stickyWrapper = input.closest('.MuiBox-root') as HTMLElement;
    expect(stickyWrapper).not.toHaveStyle({ position: 'sticky' });
  });
});
