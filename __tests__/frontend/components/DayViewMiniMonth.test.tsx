import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import DayViewMiniMonth from '@/frontend/components/Waves/DayViewMiniMonth';
import DayView from '@/frontend/components/Waves/DayView';

const date = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);
const label = (value: Date) => new Intl.DateTimeFormat('en', { dateStyle: 'full' }).format(value);
const dayButton = (value: Date) => screen.getByLabelText(label(value));
const props = {
  selectedDate: date(2026, 10, 9), today: date(2026, 10, 9),
  packages: ['Work'], hiddenPackages: new Set<string>(), packageColor: () => '#1976d2',
  onSelectDate: jest.fn(), onTogglePackage: jest.fn(),
};

function focus(value: Date) { act(() => dayButton(value).focus()); }
function press(key: string, extra = {}) { fireEvent.keyDown(document.activeElement!, { key, ...extra }); }

beforeEach(() => jest.clearAllMocks());

it('has one date Tab stop, complete weeks and full weekday names', () => {
  render(<DayViewMiniMonth {...props} />);
  const grid = screen.getByRole('grid', { name: 'October 2026' });
  expect(within(grid).getAllByRole('row')).toHaveLength(7);
  expect(within(grid).getAllByRole('columnheader').map((header) => header.getAttribute('aria-label')))
    .toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  expect(within(grid).getAllByRole('button').filter((button) => button.tabIndex === 0))
    .toEqual([dayButton(props.selectedDate)]);
  expect(within(grid).getByRole('gridcell', { selected: true })).toContainElement(dayButton(props.selectedDate));
  expect(dayButton(props.today)).toHaveAttribute('aria-current', 'date');
});

it('moves by day and week without selecting or trapping Tab', () => {
  render(<DayViewMiniMonth {...props} />);
  focus(props.selectedDate);
  press('ArrowRight'); expect(dayButton(date(2026, 10, 10))).toHaveFocus();
  press('ArrowDown'); expect(dayButton(date(2026, 10, 17))).toHaveFocus();
  press('ArrowLeft'); expect(dayButton(date(2026, 10, 16))).toHaveFocus();
  press('ArrowUp'); expect(dayButton(props.selectedDate)).toHaveFocus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  act(() => document.activeElement!.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(false);
  expect(props.onSelectDate).not.toHaveBeenCalled();
});

it('moves to week boundaries and follows focus across months and years', () => {
  render(<DayViewMiniMonth {...props} selectedDate={date(2026, 12, 31)} />);
  focus(date(2026, 12, 31));
  press('Home'); expect(dayButton(date(2026, 12, 27))).toHaveFocus();
  press('End'); expect(dayButton(date(2027, 1, 2))).toHaveFocus();
  expect(screen.getByRole('grid')).toHaveAccessibleName('January 2027');
  press('ArrowLeft'); press('ArrowLeft');
  expect(dayButton(date(2026, 12, 31))).toHaveFocus();
  expect(screen.getByRole('grid')).toHaveAccessibleName('December 2026');
});

it('clamps month and year keyboard jumps at short months and leap days', () => {
  render(<DayViewMiniMonth {...props} selectedDate={date(2028, 1, 31)} />);
  focus(date(2028, 1, 31));
  press('PageDown'); expect(dayButton(date(2028, 2, 29))).toHaveFocus();
  press('PageDown', { shiftKey: true }); expect(dayButton(date(2029, 2, 28))).toHaveFocus();
  press('PageUp', { shiftKey: true }); expect(dayButton(date(2028, 2, 28))).toHaveFocus();
  press('PageUp'); expect(dayButton(date(2028, 1, 28))).toHaveFocus();
  expect(props.onSelectDate).not.toHaveBeenCalled();
});

it('selects the focused date on activation and keeps focus after the controlled update', () => {
  function Calendar() {
    const [selectedDate, setSelectedDate] = useState(props.selectedDate);
    return <DayViewMiniMonth {...props} selectedDate={selectedDate} onSelectDate={(value) => {
      props.onSelectDate(value); setSelectedDate(value);
    }} />;
  }
  render(<Calendar />);
  focus(props.selectedDate); press('ArrowRight');
  // jsdom does not synthesize native button clicks from keyboard events.
  // Real Enter/Space activation is covered by the retained browser acceptance.
  fireEvent.click(document.activeElement!);
  expect(props.onSelectDate).toHaveBeenCalledTimes(1);
  expect(props.onSelectDate).toHaveBeenCalledWith(date(2026, 10, 10));
  expect(dayButton(date(2026, 10, 10))).toHaveFocus();
  expect(screen.getByRole('gridcell', { selected: true })).toContainElement(dayButton(date(2026, 10, 10)));
});

it('keeps a usable date after month-button browsing and same-date parent renders', () => {
  const view = render(<DayViewMiniMonth {...props} selectedDate={date(2026, 1, 31)} />);
  const next = screen.getByRole('button', { name: 'Next month' });
  act(() => next.focus()); fireEvent.click(next);
  expect(next).toHaveFocus();
  expect(screen.getByRole('grid')).toHaveAccessibleName('February 2026');
  expect(dayButton(date(2026, 2, 28))).toHaveAttribute('tabindex', '0');
  view.rerender(<DayViewMiniMonth {...props} selectedDate={date(2026, 1, 31)} />);
  expect(screen.getByRole('grid')).toHaveAccessibleName('February 2026');
  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  expect(screen.getByRole('grid')).toHaveAccessibleName('January 2026');
  expect(props.onSelectDate).not.toHaveBeenCalled();
});

it('follows an external selected day without stealing focus outside the calendar', () => {
  const view = render(<DayViewMiniMonth {...props} />);
  const filter = screen.getByRole('checkbox', { name: 'Work' });
  act(() => filter.focus());
  view.rerender(<DayViewMiniMonth {...props} selectedDate={date(2027, 3, 4)} />);
  expect(filter).toHaveFocus();
  expect(screen.getByRole('grid')).toHaveAccessibleName('March 2027');
  expect(dayButton(date(2027, 3, 4))).toHaveAttribute('tabindex', '0');
  fireEvent.click(filter); expect(props.onTogglePackage).toHaveBeenCalledWith('Work');
});

it('preserves calendar focus when an external selection changes to another month', () => {
  const view = render(<DayViewMiniMonth {...props} />);
  focus(props.selectedDate);
  view.rerender(<DayViewMiniMonth {...props} selectedDate={date(2027, 3, 4)} />);
  expect(dayButton(date(2027, 3, 4))).toHaveFocus();
});

it('keeps mouse selection and ignores browser modifier shortcuts', () => {
  render(<DayViewMiniMonth {...props} />);
  focus(props.selectedDate);
  press('ArrowLeft', { altKey: true });
  press('PageDown', { ctrlKey: true });
  expect(dayButton(props.selectedDate)).toHaveFocus();
  fireEvent.click(dayButton(date(2026, 10, 12)));
  expect(props.onSelectDate).toHaveBeenCalledWith(date(2026, 10, 12));
});

it('follows the visual weekday order in right-to-left layouts', () => {
  render(<ThemeProvider theme={createTheme({ direction: 'rtl' })}><DayViewMiniMonth {...props} /></ThemeProvider>);
  focus(props.selectedDate);
  press('ArrowLeft'); expect(dayButton(date(2026, 10, 10))).toHaveFocus();
  press('ArrowRight'); expect(dayButton(props.selectedDate)).toHaveFocus();
  expect(props.onSelectDate).not.toHaveBeenCalled();
});

it('returns focus to Choose date when the phone calendar closes after selection', () => {
  render(<DayView now={props.today.getTime()} defaultSelectedDate={props.selectedDate} data={{
    paused: false, generatedAt: props.today.toISOString(), packages: [], executions: [],
    relations: [], waves: [], components: [], orphanExecutionIds: [], flows: [],
  }} />);
  const chooseDate = screen.getByRole('button', { name: 'Choose date' });
  fireEvent.click(chooseDate);
  const monthArea = chooseDate.closest('.MuiPaper-root')! as HTMLElement;
  const selectedDay = within(monthArea).getByRole('button', { name: label(date(2026, 10, 10)) });
  act(() => selectedDay.focus());
  fireEvent.click(selectedDay);
  expect(chooseDate).toHaveAccessibleName('Choose date');
  expect(chooseDate).toHaveFocus();
});
