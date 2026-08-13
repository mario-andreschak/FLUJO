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

  it('supports single selection with Enter and arrow-key navigation', () => {
    const onFirst = jest.fn();
    const onSecond = jest.fn();
    render(
      <CardPickerGrid
        selectionMode="single"
        ariaLabel="Role choices"
        items={[
          { key: '1', label: 'First role', selected: true, content: <div>First</div>, onSelect: onFirst },
          { key: '2', label: 'Second role', content: <div>Second</div>, onSelect: onSecond },
        ]}
      />,
    );

    const first = screen.getByRole('radio', { name: 'First role' });
    const second = screen.getByRole('radio', { name: 'Second role' });
    expect(first).toHaveAttribute('aria-checked', 'true');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(onSecond).toHaveBeenCalledWith('2');
  });

  it('uses checkbox semantics for multiple selection and ignores disabled items', () => {
    const onSelect = jest.fn();
    render(
      <CardPickerGrid
        selectionMode="multiple"
        items={[
          { key: '1', label: 'Available', selected: true, content: <div>Available</div>, onSelect },
          { key: '2', label: 'Disabled', disabled: true, content: <div>Disabled</div>, onSelect },
        ]}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Available' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Disabled' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps missing references visible with a separate repair action', () => {
    const onRepair = jest.fn();
    render(
      <CardPickerGrid
        items={[{
          key: 'missing',
          content: <div>Deleted app</div>,
          missing: true,
          missingLabel: 'App unavailable',
          repairLabel: 'Remove grant',
          onRepair,
        }]}
      />,
    );

    expect(screen.getByText('App unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove grant' }));
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

});
