"use client";

import React, { useState } from 'react';
import Link from 'next/link';
import { Chip, ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { whereUsedHref, type WhereUsedRef } from '@/utils/shared/whereUsed';

/** "Used by N" with a menu of the agents/policies that use this item (#1278). */
export default function UsedByChip({ refs, label }: { refs?: readonly WhereUsedRef[]; label: 'model' | 'subflow' }) {
  const { t, formatNumber } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const count = refs?.length ?? 0;
  const text = count === 0
    ? t(label === 'model' ? 'whereUsed.modelUnused' : 'whereUsed.subflowUnused')
    : t(label === 'model' ? 'whereUsed.modelUsedBy' : 'whereUsed.subflowUsedBy', { count: formatNumber(count) });
  return (
    <>
      <Chip
        size="small"
        variant="outlined"
        label={text}
        disabled={count === 0}
        onClick={count > 0 ? (event) => { event.stopPropagation(); setAnchor(event.currentTarget); } : undefined}
        aria-haspopup={count > 0 ? 'menu' : undefined}
        sx={{ height: 22, fontSize: '0.7rem' }}
      />
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} onClick={(event) => event.stopPropagation()}
        slotProps={{ list: { 'aria-label': text } }}>
        {(refs ?? []).map(ref => (
          <MenuItem key={`${ref.kind}:${ref.id}`} component={Link} href={whereUsedHref(ref)} onClick={() => setAnchor(null)}>
            <ListItemIcon>{ref.kind === 'flow' ? <AccountTreeRoundedIcon fontSize="small" /> : <AltRouteRoundedIcon fontSize="small" />}</ListItemIcon>
            <ListItemText primary={ref.name} secondary={ref.kind === 'policy' ? t('whereUsed.policy') : undefined} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
