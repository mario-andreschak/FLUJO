'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  ButtonBase,
  Checkbox,
  FormControlLabel,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import { alpha, useTheme } from '@mui/material/styles';
import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  addCalendarMonths,
  buildMonthGrid,
  isSameCalendarDay,
  normalizeCalendarDay,
} from './dayViewCalendar';

export interface DayViewMiniMonthProps {
  selectedDate: Date;
  today: Date;
  packages: readonly string[];
  hiddenPackages: ReadonlySet<string>;
  packageColor: (packageName: string) => string;
  onSelectDate: (date: Date) => void;
  onTogglePackage: (packageName: string) => void;
  showPackageFilters?: boolean;
}

export default function DayViewMiniMonth({
  selectedDate,
  today,
  packages,
  hiddenPackages,
  packageColor,
  onSelectDate,
  onTogglePackage,
  showPackageFilters = true,
}: DayViewMiniMonthProps) {
  const theme = useTheme();
  const { formatDate, t } = useI18n();
  const [shownMonth, setShownMonth] = useState(() => normalizeCalendarDay(selectedDate));

  useEffect(() => {
    setShownMonth(normalizeCalendarDay(selectedDate));
  }, [selectedDate]);

  const grid = useMemo(() => buildMonthGrid(shownMonth), [shownMonth]);
  const weekdayLabels = useMemo(() => (
    Array.from({ length: 7 }, (_, index) => {
      // 2 August 2026 is a Sunday, giving us a stable Sunday-first label row.
      const day = new Date(2026, 7, 2 + index, 12);
      return formatDate(day, { weekday: 'narrow' });
    })
  ), [formatDate]);

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 760 }}>
            {formatDate(shownMonth, { month: 'long', year: 'numeric' })}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <IconButton
              size="small"
              aria-label={t('waves.day.previousMonth')}
              onClick={() => setShownMonth((current) => addCalendarMonths(current, -1))}
            >
              <ChevronLeftRoundedIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              aria-label={t('waves.day.nextMonth')}
              onClick={() => setShownMonth((current) => addCalendarMonths(current, 1))}
            >
              <ChevronRightRoundedIcon fontSize="small" />
            </IconButton>
          </Box>
        </Box>

        <Box
          role="grid"
          aria-label={formatDate(shownMonth, { month: 'long', year: 'numeric' })}
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 0.25 }}
        >
          {weekdayLabels.map((label, index) => (
            <Typography
              key={`${label}-${index}`}
              role="columnheader"
              variant="caption"
              color="text.secondary"
              sx={{ textAlign: 'center', fontSize: 10, fontWeight: 720, py: 0.35 }}
            >
              {label}
            </Typography>
          ))}
          {grid.map((cell) => {
            const selected = isSameCalendarDay(cell.date, selectedDate);
            const isToday = isSameCalendarDay(cell.date, today);
            return (
              <ButtonBase
                key={cell.key}
                role="gridcell"
                aria-selected={selected}
                aria-current={isToday ? 'date' : undefined}
                aria-label={formatDate(cell.date, { dateStyle: 'full' })}
                onClick={() => onSelectDate(cell.date)}
                sx={{
                  width: 30,
                  height: 30,
                  justifySelf: 'center',
                  borderRadius: '50%',
                  fontSize: 12,
                  fontWeight: selected ? 780 : isToday ? 720 : 540,
                  color: selected
                    ? 'primary.contrastText'
                    : cell.inMonth
                      ? 'text.primary'
                      : 'text.disabled',
                  bgcolor: selected ? 'primary.main' : 'transparent',
                  border: isToday && !selected
                    ? `1px solid ${theme.palette.primary.main}`
                    : '1px solid transparent',
                  '&:hover': {
                    bgcolor: selected ? 'primary.dark' : alpha(theme.palette.primary.main, 0.1),
                  },
                  '&:focus-visible': {
                    outline: `3px solid ${alpha(theme.palette.primary.main, 0.26)}`,
                    outlineOffset: 1,
                  },
                }}
              >
                {cell.date.getDate()}
              </ButtonBase>
            );
          })}
        </Box>
      </Box>

      {showPackageFilters && packages.length > 0 && (
        <Box>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ display: 'block', fontSize: 10, letterSpacing: '0.1em', mb: 0.35 }}
          >
            {t('waves.day.packages')}
          </Typography>
          <Stack spacing={0.15}>
            {packages.map((packageName) => {
              const color = packageColor(packageName);
              return (
                <FormControlLabel
                  key={packageName}
                  sx={{ m: 0, minWidth: 0, '& .MuiFormControlLabel-label': { minWidth: 0 } }}
                  control={(
                    <Checkbox
                      size="small"
                      checked={!hiddenPackages.has(packageName)}
                      onChange={() => onTogglePackage(packageName)}
                      sx={{ color, '&.Mui-checked': { color }, py: 0.4 }}
                    />
                  )}
                  label={(
                    <Typography variant="body2" noWrap title={packageName}>
                      {packageName}
                    </Typography>
                  )}
                />
              );
            })}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
