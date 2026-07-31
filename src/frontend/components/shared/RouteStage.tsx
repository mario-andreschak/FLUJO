"use client";

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { useStorage } from '@/frontend/contexts/StorageContext';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { resolveRiverScene } from '../AmbientWorld/sceneMap';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const MAIN_CONTENT_ID = 'main-content';

interface RouteStageProps {
  children: ReactNode;
}

function getEntranceOffset(previousPathname: string | null, pathname: string) {
  if (!previousPathname || previousPathname === pathname) {
    return { x: 0, y: 12 };
  }

  const previous = resolveRiverScene(previousPathname);
  const next = resolveRiverScene(pathname);
  const deltaX = previous.x - next.x;
  const deltaY = previous.y - next.y;
  const distance = Math.hypot(deltaX, deltaY);

  if (!distance) return { x: 0, y: 8 };

  return {
    x: Math.round((deltaX / distance) * 18),
    y: Math.round((deltaY / distance) * 12),
  };
}

/**
 * Animates the app's existing main landmark on navigation. This component is
 * intentionally DOM-free: it can sit inside `#main-content` without changing
 * flex/grid geometry, stacking contexts, or direct-child selectors.
 */
export default function RouteStage({ children }: RouteStageProps) {
  const pathname = usePathname();
  const { settings, settingsHydrated } = useStorage();
  const { visualStyle } = useTheme();
  const previousPathnameRef = useRef<string | null>(null);

  const isEnabled =
    settingsHydrated &&
    settings.experimental?.enabled === true &&
    visualStyle === 'modern';

  useEffect(() => {
    const previousPathname = previousPathnameRef.current;
    previousPathnameRef.current = pathname;

    if (!isEnabled) return;

    const main = document.getElementById(MAIN_CONTENT_ID);
    if (!main || typeof main.animate !== 'function') return;

    const motionPreference =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(REDUCED_MOTION_QUERY)
        : null;

    let animation: Animation | null = null;

    const stopAnimation = () => {
      animation?.cancel();
      animation = null;
    };

    if (!motionPreference?.matches) {
      const offset = getEntranceOffset(previousPathname, pathname);

      animation = main.animate(
        [
          {
            opacity: 0.36,
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(0.992)`,
            filter: 'blur(4px)',
          },
          {
            opacity: 1,
            transform: 'translate3d(0, 0, 0) scale(1)',
            filter: 'blur(0)',
          },
        ],
        {
          duration: previousPathname ? 460 : 520,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both',
        },
      );

      animation.addEventListener('finish', stopAnimation, { once: true });
    }

    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopAnimation();
    };

    motionPreference?.addEventListener('change', handleMotionPreferenceChange);

    return () => {
      motionPreference?.removeEventListener('change', handleMotionPreferenceChange);
      stopAnimation();
    };
  }, [isEnabled, pathname]);

  return children;
}
