import React, { useState } from 'react';
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
  it('offers one radio Tab stop and selects with wrapping arrows, skipping disabled items', () => {
    function Picker() {
      const [selected, setSelected] = useState('two');
      return <CardPickerGrid selectionMode="single" items={['one', 'disabled', 'two'].map((key) => ({
        key, label: key, content: <div>{key}</div>, disabled: key === 'disabled',
        selected: selected === key, onSelect: () => setSelected(key),
      }))} />;
    }
    render(<Picker />);
    const one = screen.getByRole('radio', { name: 'one' });
    const two = screen.getByRole('radio', { name: 'two' });
    expect(one).toHaveAttribute('tabindex', '-1');
    expect(two).toHaveAttribute('tabindex', '0');
    two.focus();
    fireEvent.keyDown(two, { key: 'ArrowRight' });
    expect(one).toHaveFocus();
    expect(one).toHaveAttribute('aria-checked', 'true');
    expect(one).toHaveAttribute('tabindex', '0');
    expect(two).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(one, { key: 'ArrowLeft' });
    expect(two).toHaveFocus();
    expect(two).toHaveAttribute('aria-checked', 'true');
  });

  it('does not expose collapsed radio groups as Tab stops or arrow targets during exit', () => {
    const onSelect = jest.fn();
    const groups = ['a', 'b'].map((key) => ({ key, label: key, items: [{
      key, label: key, content: <div>{key}</div>, selected: key === 'a', onSelect,
    }] }));
    const view = render(<CardPickerGrid selectionMode="single" groups={groups} collapsedKeys={new Set()} />);
    view.rerender(<CardPickerGrid selectionMode="single" groups={groups} collapsedKeys={new Set(['a'])} />);
    const b = screen.getByRole('radio', { name: 'b' });
    expect(b).toHaveAttribute('tabindex', '0');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowLeft' });
    expect(b).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalledWith('a');
  });

  it('restores a radio Tab stop when search hides the selection', () => {
    render(<CardPickerGrid searchable autoFocusSearch={false} selectionMode="single" items={[
      { key: 'a', label: 'A', searchText: 'Apple', selected: true, content: <div>Apple</div>, onSelect: jest.fn() },
      { key: 'b', label: 'B', searchText: 'Berry', content: <div>Berry</div>, onSelect: jest.fn() },
    ]} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Berry' } });
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('radio', { name: 'A' })).not.toBeInTheDocument();
  });

  it('makes a collapsed body inert immediately while keeping its header usable', () => {
    const onSelect = jest.fn();
    const groups = [{ key: 'apps', label: 'Apps', items: [{
      key: 'missing', label: 'Missing app', content: <div>Missing app</div>,
      onSelect, missing: true, onRepair: jest.fn(), repairLabel: 'Repair app',
    }] }];
    const view = render(<CardPickerGrid selectionMode="multiple" groups={groups} collapsedKeys={new Set()} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Missing app' });
    const body = checkbox.closest('.MuiCollapse-root');
    view.rerender(<CardPickerGrid selectionMode="multiple" groups={groups} collapsedKeys={new Set(['apps'])} />);
    expect(body).toHaveAttribute('inert');
    expect(body).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('checkbox', { name: 'Missing app' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repair app' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apps/ })).toHaveAttribute('tabindex', '0');
    view.rerender(<CardPickerGrid selectionMode="multiple" groups={groups} collapsedKeys={new Set()} />);
    expect(body).not.toHaveAttribute('inert');
    expect(screen.getByRole('checkbox', { name: 'Missing app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repair app' })).toBeInTheDocument();
  });

  it('toggles a group once when its inner collapse button is activated by keyboard', () => {
    const onToggleGroup = jest.fn();
    render(<CardPickerGrid groups={[{ key: 'apps', label: 'Apps', items }]} onToggleGroup={onToggleGroup} />);
    const toggle = screen.getByRole('button', { name: 'common.collapseSection' });
    fireEvent.keyDown(toggle, { key: 'Enter' });
    fireEvent.click(toggle);
    expect(onToggleGroup).toHaveBeenCalledTimes(1);
  });

  it('keeps repair controls outside selection semantics and never selects on their keyboard events', () => {
    const onSelect = jest.fn();
    const onRepair = jest.fn();
    render(<CardPickerGrid selectionMode="multiple" items={[{
      key: 'missing', label: 'Missing app', content: <div>Missing app</div>,
      missing: true, onSelect, onRepair, repairLabel: 'Repair app',
    }]} />);
    const repair = screen.getByRole('button', { name: 'Repair app' });
    fireEvent.keyDown(repair, { key: 'Enter' });
    fireEvent.keyDown(repair, { key: ' ' });
    fireEvent.click(repair);
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Missing app' })).not.toContainElement(repair);
  });

  it('does not intercept arrow or activation keys from nested controls', () => {
    const onSelect = jest.fn();
    render(<CardPickerGrid items={[{
      key: 'a', label: 'Card', onSelect, content: <input aria-label="Edit card" />,
    }]} />);
    const editor = screen.getByRole('textbox', { name: 'Edit card' });
    editor.focus();
    fireEvent.keyDown(editor, { key: ' ' });
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    expect(editor).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

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
