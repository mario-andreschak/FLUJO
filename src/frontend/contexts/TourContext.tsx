"use client";

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { TOUR_STEPS } from '@/frontend/components/Tour/tourSteps';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/contexts/TourContext');

interface TourContextType {
  /** True while the guided tour is running. */
  isActive: boolean;
  /** Index of the current step within TOUR_STEPS. */
  stepIndex: number;
  /** Start (or restart) the tour from the beginning. */
  startTour: () => void;
  /** Advance to the next step, or finish on the last step. */
  next: () => void;
  /** Go back one step (no-op on the first step). */
  back: () => void;
  /** End the tour and persist completion. */
  endTour: () => void;
}

const TourContext = createContext<TourContextType>({
  isActive: false,
  stepIndex: 0,
  startTour: () => {},
  next: () => {},
  back: () => {},
  endTour: () => {},
});

export const useTour = () => useContext(TourContext);

export const TourProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { settings, updateSettings, isLoading } = useStorage();
  const [isActive, setIsActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  // Guard so the first-run auto-start only fires once per app load.
  const autoStartChecked = useRef(false);

  const persistCompleted = useCallback(() => {
    // Fire-and-forget; failure to persist just means the tour may re-show.
    updateSettings({
      ...settings,
      onboarding: { ...(settings.onboarding ?? {}), completed: true },
    }).catch((error) => log.warn('Failed to persist onboarding completion', error));
  }, [settings, updateSettings]);

  const startTour = useCallback(() => {
    log.info('Starting guided tour');
    setStepIndex(0);
    setIsActive(true);
  }, []);

  const endTour = useCallback(() => {
    log.info('Ending guided tour');
    setIsActive(false);
    persistCompleted();
  }, [persistCompleted]);

  const next = useCallback(() => {
    setStepIndex((idx) => {
      if (idx >= TOUR_STEPS.length - 1) {
        // Last step -> finish.
        setIsActive(false);
        persistCompleted();
        return idx;
      }
      return idx + 1;
    });
  }, [persistCompleted]);

  const back = useCallback(() => {
    setStepIndex((idx) => Math.max(0, idx - 1));
  }, []);

  // First-run auto-start: once settings have hydrated, launch the tour if the
  // user has never completed it.
  useEffect(() => {
    if (isLoading || autoStartChecked.current) {
      return;
    }
    autoStartChecked.current = true;
    if (settings.onboarding?.completed !== true) {
      log.info('First run detected — auto-starting guided tour');
      startTour();
    }
  }, [isLoading, settings.onboarding?.completed, startTour]);

  return (
    <TourContext.Provider value={{ isActive, stepIndex, startTour, next, back, endTour }}>
      {children}
    </TourContext.Provider>
  );
};
