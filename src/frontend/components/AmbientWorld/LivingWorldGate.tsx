"use client";

import dynamic from 'next/dynamic';

import { useStorage } from '@/frontend/contexts/StorageContext';
import { useTheme } from '@/frontend/contexts/ThemeContext';

const RiverWorld = dynamic(() => import('./RiverWorld'), {
  ssr: false,
  loading: () => null,
});

export default function LivingWorldGate() {
  const { settings, settingsHydrated } = useStorage();
  const { visualStyle } = useTheme();
  const enabled = (
    settingsHydrated
    && settings?.experimental?.enabled === true
    && visualStyle === 'modern'
  );

  if (!enabled) return null;

  return <RiverWorld />;
}
