"use client";

import dynamic from 'next/dynamic';

import { useTheme } from '@/frontend/contexts/ThemeContext';

const RiverWorld = dynamic(() => import('./RiverWorld'), {
  ssr: false,
  loading: () => null,
});

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
