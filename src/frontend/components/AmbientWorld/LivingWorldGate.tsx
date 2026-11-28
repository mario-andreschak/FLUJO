"use client";

import { useTheme } from '@/frontend/contexts/ThemeContext';
import { lazyOptional } from '@/frontend/lazy';

const RiverWorld = lazyOptional(() => import('./RiverWorld'), { name: 'RiverWorld' });

export default function LivingWorldGate() {
  const { livingWorldEnabled, themeHydrated, visualStyle } = useTheme();
  const enabled = (
    themeHydrated
    && livingWorldEnabled
    && visualStyle === 'modern'
  );

  if (!enabled) return null;

  return <RiverWorld />;
}
